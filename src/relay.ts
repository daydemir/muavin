import { validateEnv } from "./env";
import { Bot, type Context } from "grammy";
import { writeFile, mkdir, unlink } from "fs/promises";
import { watch } from "fs";
import { join } from "path";
import { homedir } from "os";
import { callClaude, killAllChildren, waitForChildren, activeChildPids } from "./claude";
import { buildContext, listAgents, updateAgent, type AgentFile } from "./agents";
import { syncJobPlists } from "./jobs";
import { acquireLock, releaseLock, loadConfig, MUAVIN_DIR, saveJson, loadJson, writeOutbox, readOutbox, clearOutboxItems, claimOutboxItems, restoreUndeliveredOutbox, timestamp, isSkipResponse, formatLocalTime, isPidAlive, formatError } from "./utils";
import { sendAndLog, toTelegramMarkdown } from "./telegram";
import { createMuaBlock, createUserBlock, ingestFileArtifactFromPath } from "./blocks";
import { logSystemEvent } from "./events";

validateEnv();

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// ── Config ──────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const SESSIONS_FILE = join(MUAVIN_DIR, "sessions.json");
const UPLOADS_DIR = join(MUAVIN_DIR, "uploads");

// ── Constants ────────────────────────────────────────────────
const TYPING_INTERVAL_MS = 4000;
const OUTBOX_DEBOUNCE_MS = 2000;
const AGENT_DEBOUNCE_MS = 1000;
const CHECK_INTERVAL_MS = 30000;
const STALE_STATUS_MS = 5 * 60 * 1000;
const STUCK_AGENT_MS = 2 * 60 * 60 * 1000;
const TELEGRAM_MAX_LENGTH = 4000;


// ── Allow list from config ─────────────────────────────────
const config = await loadConfig();
const allowUsers = new Set<number>(config.allowUsers ?? []);
const allowGroups = new Set<number>(config.allowGroups ?? []);

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

await mkdir(MUAVIN_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });
await mkdir(join(MUAVIN_DIR, "outbox"), { recursive: true });
await mkdir(join(MUAVIN_DIR, "agents"), { recursive: true });
await mkdir(join(MUAVIN_DIR, "system"), { recursive: true });

// ── Lock file ───────────────────────────────────────────────

if (!(await acquireLock("relay"))) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

// Write relay start timestamp for heartbeat error filtering
await writeFile(join(MUAVIN_DIR, "relay-started-at"), Date.now().toString(), "utf-8");

// Truncate error logs on startup so stale errors don't pollute future analysis
const LOG_DIR = join(homedir(), "Library/Logs");
for (const logFile of ["muavin-relay.error.log", "muavin-jobs.error.log"]) {
  try {
    await writeFile(join(LOG_DIR, logFile), "", "utf-8");
  } catch {
    // ignore — log file may not exist yet
  }
}

// ── Per-chat sessions ───────────────────────────────────────

interface SessionState {
  sessionId: string | null;
  updatedAt: string;
}

type SessionMap = Record<string, SessionState>;

async function loadSessions(): Promise<SessionMap> {
  return await loadJson<SessionMap>(SESSIONS_FILE) ?? {};
}

async function saveSessions(map: SessionMap): Promise<void> {
  await saveJson(SESSIONS_FILE, map);
}

function getSession(map: SessionMap, chatId: string): SessionState {
  return map[chatId] ?? { sessionId: null, updatedAt: new Date().toISOString() };
}

const sessions = await loadSessions();

// ── Message queue (two-array queue) ─────────────────────────

interface QueuedUserMessage {
  ctx: Context;
  prompt: string;
  inboundContent: string;
  sourceRef?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const userQueue: QueuedUserMessage[] = [];
let outboxPending = false;
let processing = false;

function scheduleQueue(): void {
  if (!processing) {
    drainQueues().catch(e => console.error("drainQueues error:", e));
  }
}

async function drainQueues(): Promise<void> {
  if (processing) return;
  processing = true;

  try {
    while (true) {
      // Process user messages first
      while (userQueue.length > 0) {
        const item = userQueue.shift()!;
        await processUserMessage(item);
      }

      if (outboxPending) {
        outboxPending = false;
        const delivery = await prepareOutbox();

        if (delivery) {
          // Drain user messages that arrived during formatting
          while (userQueue.length > 0) {
            const item = userQueue.shift()!;
            await processUserMessage(item);
          }

          const success = await sendAndLog(config.owner, delivery.text, { parseMode: "Markdown" });
          if (success) {
            await clearOutboxItems(delivery.claimedFiles);
            console.log(timestamp("relay"), "Delivered outbox item(s) to owner");
          } else {
            console.error(timestamp("relay"), "Outbox delivery send failed, restoring items");
            await restoreUndeliveredOutbox();
          }
        }
      } else {
        break;
      }
    }
  } finally {
    processing = false;
  }
}

function telegramSourceRef(ctx: Context): Record<string, unknown> {
  return {
    chat_id: String(ctx.chat?.id ?? ""),
    message_id: ctx.message?.message_id ?? null,
  };
}

function telegramMetadata(ctx: Context, direction: "inbound" | "outbound"): Record<string, unknown> {
  return {
    direction,
    chat_type: ctx.chat?.type ?? "unknown",
    sender_id: ctx.from?.id ?? null,
    sender_name: ctx.from?.first_name ?? null,
    sender_username: ctx.from?.username ?? null,
  };
}

async function logUserTelegramBlock(ctx: Context, content: string, opts?: {
  sourceRef?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await createUserBlock({
    rawContent: content,
    source: "chat",
    sourceRef: opts?.sourceRef ?? telegramSourceRef(ctx),
    metadata: { ...telegramMetadata(ctx, "inbound"), ...(opts?.metadata ?? {}) },
  });
}

async function logMuaTelegramBlock(ctx: Context, content: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await createMuaBlock({
    content,
    source: "chat",
    sourceRef: telegramSourceRef(ctx),
    metadata: { ...telegramMetadata(ctx, "outbound"), ...metadata },
    blockKind: "note",
    confidence: 1,
  });
}

async function processUserMessage(item: QueuedUserMessage): Promise<void> {
  const { ctx, prompt, inboundContent, sourceRef, metadata } = item;
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, TYPING_INTERVAL_MS);

  try {
    await logUserTelegramBlock(ctx, inboundContent, {
      sourceRef,
      metadata,
    }).catch(async (persistError) => {
      await logSystemEvent({
        level: "error",
        component: "relay",
        eventType: "inbound_block_persist_failed",
        message: formatError(persistError),
        payload: { prompt: inboundContent.slice(0, 300), chat_id: ctx.chat?.id ?? null },
      }).catch(() => {});
    });

    // Build context
    const numericChatId = ctx.chat?.id ?? 0;
    const appendSystemPrompt = await buildContext({
      query: prompt,
      chatId: numericChatId,
      recentCount: config.recentMessageCount ?? 20,
      full: true,
    });

    // Build prompt with time context
    const now = new Date();
    const timeStr = formatLocalTime(now);

    const chatType = ctx.chat?.type ?? "private";
    const senderName = ctx.from?.first_name ?? "User";
    let fullPrompt = `Current time: ${timeStr}\nChannel: ${chatType}`;
    if (chatType !== "private") {
      fullPrompt += `\nSender: ${senderName}\nNote: Address ${senderName} by name. Be concise in group chats.`;
    }
    fullPrompt += `\n\n${prompt}`;
    fullPrompt += `\nChatId: ${numericChatId}`;

    const chatId = String(ctx.chat?.id ?? "unknown");
    const session = getSession(sessions, chatId);

    const result = await callClaude(fullPrompt, {
      resume: session.sessionId ?? undefined,
      appendSystemPrompt,
      timeoutMs: config.relayTimeoutMs ?? 600000,
      maxTurns: config.relayMaxTurns ?? 100,
      disallowedTools: ["Bash(claude*)"],
    });

    // Save session
    sessions[chatId] = {
      sessionId: result.sessionId,
      updatedAt: new Date().toISOString(),
    };
    await saveSessions(sessions);

    // Check if Claude wants to skip (internal signal, not sent to user)
    if (isSkipResponse(result.text)) {
      console.log(timestamp("relay"), "Response skipped (SKIP signal)");
      return;
    }

    await logMuaTelegramBlock(ctx, result.text, { kind: "relay_reply" });

    if (!result.text.trim()) {
      await ctx.reply("Done.");
    } else {
      await sendResponse(ctx, result.text);
    }
  } catch (error) {
    console.error("Error in processUserMessage:", error);
    const errorMsg = `Error: ${formatError(error)}`;
    await logSystemEvent({
      level: "error",
      component: "relay",
      eventType: "process_user_message_failed",
      message: errorMsg,
      payload: { prompt: prompt.slice(0, 500), chat_id: ctx.chat?.id ?? null },
    }).catch(() => {});
    await ctx.reply(errorMsg);
  } finally {
    clearInterval(typingInterval);
  }
}

interface OutboxDelivery {
  text: string;
  claimedFiles: string[];
}

async function prepareOutbox(): Promise<OutboxDelivery | null> {
  try {
    const outboxItems = await readOutbox();
    if (outboxItems.length === 0) return null;

    // Claim items (rename to .processing) — originals restored on failure
    await claimOutboxItems(outboxItems.map(i => i._filename));

    // Build voice context
    const appendSystemPrompt = await buildContext({
      query: "outbox delivery",
      chatId: config.owner,
      recentCount: config.recentMessageCount ?? 20,
      full: true,
    });

    // Build prompt listing outbox items
    const itemsList = outboxItems.map((item, idx) =>
      `${idx + 1}. [${item.source}${item.sourceId ? `:${item.sourceId}` : ""}] ${item.task ?? ""}:\n${item.result}`
    ).join("\n\n");

    const prompt = `You are muavin. The following are results from your background workers (sub-agents and jobs).\nYour job is to relay these to the user — summarize, interpret, and editorialize as you see fit.\nYou are the manager; these are employee reports. Deliver them as YOUR communication to YOUR user.\n\nResults to deliver:\n\n${itemsList}\n\nIMPORTANT:\n- Check [Recent Conversation] in your context for any prior discussion of these topics\n- If an issue was already delivered or discussed within the last 20 turns, respond with SKIP\n- Do not acknowledge redundancy ("already covered this...") and then re-explain — just SKIP\n- Only deliver genuinely new information or actionable updates\n- Be aggressive about silence on known issues\n\nIf nothing is worth delivering, respond with exactly: SKIP\n\nIf delivering, be concise and focus only on what's new or actionable.`;

    const result = await callClaude(prompt, {
      appendSystemPrompt,
      timeoutMs: config.relayTimeoutMs ?? 600000,
      maxTurns: config.relayMaxTurns ?? 100,
      noSessionPersistence: true,
    });

    if (isSkipResponse(result.text)) {
      console.log(timestamp("relay"), "Outbox delivery skipped by voice");
      await clearOutboxItems(outboxItems.map(i => `${i._filename}.processing`));
      return null;
    }

    return { text: result.text, claimedFiles: outboxItems.map(i => `${i._filename}.processing`) };
  } catch (error) {
    console.error(timestamp("relay"), "Error in prepareOutbox:", error);
    await restoreUndeliveredOutbox();
    return null;
  }
}

// ── Agent processing (background) ───────────────────────────

const agentConcurrency = config.agentConcurrency ?? 10;
let runningAgentCount = (await listAgents({ status: "running" })).length;

async function checkPendingAgents(): Promise<void> {
  try {
    const pending = await listAgents({ status: "pending" });
    const availableSlots = agentConcurrency - runningAgentCount;

    if (pending.length > 0 && availableSlots > 0) {
      const toRun = pending.slice(0, availableSlots);
      for (const agent of toRun) {
        // Run in background (don't await)
        runAgent(agent).catch(e =>
          console.error(timestamp("relay"), `runAgent ${agent.id} failed:`, e)
        );
      }
    }
  } catch (error) {
    console.error(timestamp("relay"), "checkPendingAgents error:", error);
  }
}

function agentOutboxItem(agent: AgentFile, result: string): Parameters<typeof writeOutbox>[0] {
  return {
    source: "agent",
    sourceId: agent.id,
    task: agent.task,
    result,
    chatId: agent.chatId,
    createdAt: new Date().toISOString(),
  };
}

async function runAgent(agent: AgentFile): Promise<void> {
  runningAgentCount++;
  const startTime = Date.now();

  try {
    // Mark as running
    await updateAgent(agent.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      lastStatusAt: new Date().toISOString(),
      pid: process.pid,
    }, agent._filename);

    console.log(timestamp("relay"), `Starting agent ${agent.id}: "${agent.task}"`);

    // Build worker context (not full voice context)
    const appendSystemPrompt = await buildContext({
      query: agent.task,
      chatId: agent.chatId,
      full: false,
    });

    // Call Claude
    const result = await callClaude(agent.prompt, {
      appendSystemPrompt,
      noSessionPersistence: true,
      cwd: join(MUAVIN_DIR, "system"),
      timeoutMs: config.agentTimeoutMs ?? 600000,
      maxTurns: config.agentMaxTurns ?? 100,
      model: agent.model,
    });

    // Mark as completed
    await updateAgent(agent.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      result: result.text,
    }, agent._filename);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(timestamp("relay"), `Agent ${agent.id} completed in ${elapsed}s`);

    // Write to outbox (watcher triggers delivery)
    await writeOutbox(agentOutboxItem(agent, result.text));
  } catch (error) {
    // Mark as failed
    const errorMsg = formatError(error);
    await updateAgent(agent.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: errorMsg,
    }, agent._filename);

    console.error(timestamp("relay"), `Agent ${agent.id} failed:`, errorMsg);

    // Write error to outbox (watcher triggers delivery)
    await writeOutbox(agentOutboxItem(agent, `Agent failed: ${errorMsg}`));
  } finally {
    runningAgentCount--;
  }
}

async function checkRunningAgents(): Promise<void> {
  try {
    const running = await listAgents({ status: "running" });
    const now = Date.now();

    for (const agent of running) {
      const lastStatusAt = agent.lastStatusAt ? new Date(agent.lastStatusAt).getTime() : 0;
      const startedAt = agent.startedAt ? new Date(agent.startedAt).getTime() : 0;

      // Check for stale status (>5min since last update)
      if (lastStatusAt > 0 && now - lastStatusAt > STALE_STATUS_MS) {
        const elapsed = Math.round((now - startedAt) / 1000 / 60);
        console.log(timestamp("relay"), `Agent ${agent.id} running for ${elapsed}m (stale status)`);

        await writeOutbox(agentOutboxItem(agent, `Agent "${agent.task}" still running (${elapsed}m elapsed)`));

        // Update lastStatusAt
        await updateAgent(agent.id, {
          lastStatusAt: new Date().toISOString(),
        }, agent._filename);
      }

      // Check for stuck agents (>2h with dead PID)
      if (startedAt > 0 && now - startedAt > STUCK_AGENT_MS) {
        const pidAlive = agent.pid ? isPidAlive(agent.pid) : false;

        if (!pidAlive) {
          console.log(timestamp("relay"), `Agent ${agent.id} stuck (>2h, dead PID), marking as failed`);

          await updateAgent(agent.id, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: "Agent stuck (>2h with dead PID)",
          }, agent._filename);

          await writeOutbox(agentOutboxItem(agent, `Agent "${agent.task}" stuck and marked as failed`));
        }
      }
    }
  } catch (error) {
    console.error(timestamp("relay"), "checkRunningAgents error:", error);
  }
}

// ── Outbox watcher ──────────────────────────────────────────

let outboxDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const OUTBOX_DIR = join(MUAVIN_DIR, "outbox");

const outboxWatcher = watch(OUTBOX_DIR, () => {
  if (outboxDebounceTimer) clearTimeout(outboxDebounceTimer);
  outboxDebounceTimer = setTimeout(() => {
    outboxPending = true;
    scheduleQueue();
  }, OUTBOX_DEBOUNCE_MS);
});

// ── Agent directory watcher ─────────────────────────────────

let agentDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const AGENTS_DIR = join(MUAVIN_DIR, "agents");

const agentWatcher = watch(AGENTS_DIR, () => {
  if (agentDebounceTimer) clearTimeout(agentDebounceTimer);
  agentDebounceTimer = setTimeout(() => {
    checkPendingAgents().catch(e => console.error("checkPendingAgents error:", e));
  }, AGENT_DEBOUNCE_MS);
});

// ── Agent check interval ────────────────────────────────────

const agentCheckInterval = setInterval(() => {
  checkPendingAgents().catch(e => console.error("checkPendingAgents error:", e));
  checkRunningAgents().catch(e => console.error("checkRunningAgents error:", e));
}, CHECK_INTERVAL_MS);

const outboxCheckInterval = setInterval(() => {
  outboxPending = true;
  scheduleQueue();
}, CHECK_INTERVAL_MS);

// Check pending agents once at startup
checkPendingAgents().catch(e => console.error("checkPendingAgents error:", e));

// ── Bot setup ───────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);

// Cache bot info for group mention detection
const botInfo = await bot.api.getMe();
const botUsername = botInfo.username ?? "";

bot.catch((err) => {
  console.error("Bot error:", err.message);
  err.ctx.reply("Something went wrong. Try again.").catch(() => {});
});

// Auth middleware
bot.use(async (ctx, next) => {
  const chatType = ctx.chat?.type;
  if (chatType === "private") {
    if (!allowUsers.has(ctx.from?.id ?? 0)) {
      await ctx.reply("Private bot.");
      return;
    }
  } else if (chatType === "group" || chatType === "supergroup") {
    if (!allowGroups.has(ctx.chat?.id ?? 0)) {
      return; // silent ignore for non-allowed groups
    }
  } else {
    return;
  }
  await next();
});

// ── Core message handler ────────────────────────────────────

async function handleMessage(ctx: Context, prompt: string, opts?: {
  inboundContent?: string;
  sourceRef?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await ctx.replyWithChatAction("typing");
  userQueue.push({
    ctx,
    prompt,
    inboundContent: opts?.inboundContent ?? prompt,
    sourceRef: opts?.sourceRef,
    metadata: opts?.metadata,
  });
  scheduleQueue();
}

// ── Text messages ───────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;

  // Group mention detection
  const chatType = ctx.chat?.type;
  if (chatType === "group" || chatType === "supergroup") {
    const isReply = ctx.message.reply_to_message?.from?.id === botInfo.id;
    const isMentioned = text.includes(`@${botUsername}`);
    if (!isReply && !isMentioned) return;
  }

  await handleMessage(ctx, text, {
    inboundContent: text,
    sourceRef: telegramSourceRef(ctx),
  });
});

// ── Photos ──────────────────────────────────────────────────

bot.on("message:photo", async (ctx) => {
  let filePath: string | null = null;
  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    filePath = join(UPLOADS_DIR, `photo_${Date.now()}.jpg`);
    const res = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
      { keepalive: false, signal: AbortSignal.timeout(30_000) } as RequestInit,
    );
    if (!res.ok) throw new Error(`Photo download failed: ${res.status} ${res.statusText}`);
    await writeFile(filePath, Buffer.from(await res.arrayBuffer()));

    const caption = (ctx.message.caption || "").trim();
    const artifact = await ingestFileArtifactFromPath({
      filePath,
      sourceType: "file",
      title: `photo_${Date.now()}.jpg`,
      metadata: {
        channel: "telegram",
        source_ref: telegramSourceRef(ctx),
        telegram_photo_file_id: photo.file_id,
      },
    });

    const inboundContent = caption
      ? `shared a photo. ${caption}`
      : "shared a photo.";
    const prompt = caption
      ? `I shared a photo (${artifact.artifactId}). ${caption}`
      : `I shared a photo (${artifact.artifactId}).`;

    await handleMessage(ctx, prompt, {
      inboundContent,
      sourceRef: {
        ...telegramSourceRef(ctx),
        artifact_id: artifact.artifactId,
      },
      metadata: { attachment_type: "photo", artifact_id: artifact.artifactId },
    });
  } catch (error) {
    console.error("Photo error:", error);
    await logSystemEvent({
      level: "error",
      component: "relay",
      eventType: "photo_ingest_failed",
      message: formatError(error),
      payload: { chat_id: ctx.chat?.id ?? null, message_id: ctx.message?.message_id ?? null },
    }).catch(() => {});
    await ctx.reply("Could not process photo.");
  } finally {
    if (filePath) {
      await unlink(filePath).catch(() => {});
    }
  }
});

// ── Documents ───────────────────────────────────────────────

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  let filePath: string | null = null;
  try {
    const file = await ctx.getFile();
    const fileName = doc.file_name || `file_${Date.now()}`;
    filePath = join(UPLOADS_DIR, `${Date.now()}_${fileName}`);

    const res = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
      { keepalive: false, signal: AbortSignal.timeout(30_000) } as RequestInit,
    );
    if (!res.ok) throw new Error(`Document download failed: ${res.status} ${res.statusText}`);
    await writeFile(filePath, Buffer.from(await res.arrayBuffer()));

    const caption = (ctx.message.caption || "").trim();
    const artifact = await ingestFileArtifactFromPath({
      filePath,
      sourceType: "file",
      title: fileName,
      metadata: {
        channel: "telegram",
        source_ref: telegramSourceRef(ctx),
        telegram_document_file_id: doc.file_id,
      },
    });

    const inboundContent = caption
      ? `shared a document (${fileName}). ${caption}`
      : `shared a document (${fileName}).`;
    const prompt = caption
      ? `I shared a document (${fileName}, artifact ${artifact.artifactId}). ${caption}`
      : `I shared a document (${fileName}, artifact ${artifact.artifactId}).`;

    await handleMessage(ctx, prompt, {
      inboundContent,
      sourceRef: {
        ...telegramSourceRef(ctx),
        artifact_id: artifact.artifactId,
      },
      metadata: { attachment_type: "document", artifact_id: artifact.artifactId, file_name: fileName },
    });
  } catch (error) {
    console.error("Document error:", error);
    await logSystemEvent({
      level: "error",
      component: "relay",
      eventType: "document_ingest_failed",
      message: formatError(error),
      payload: { chat_id: ctx.chat?.id ?? null, message_id: ctx.message?.message_id ?? null },
    }).catch(() => {});
    await ctx.reply("Could not process document.");
  } finally {
    if (filePath) {
      await unlink(filePath).catch(() => {});
    }
  }
});

// ── Voice (not yet supported) ───────────────────────────────

bot.on("message:voice", async (ctx) => {
  await ctx.reply(
    "Voice messages not yet supported — type your message instead.",
  );
});

// ── Response chunking ───────────────────────────────────────

async function sendChunk(ctx: Context, formatted: string, plain: string): Promise<void> {
  try {
    await ctx.reply(formatted, { parse_mode: "Markdown" });
  } catch (e: any) {
    if (e?.description?.includes("can't parse") || e?.error_code === 400) {
      console.log("Markdown parse failed, retrying without parse_mode");
      await ctx.reply(plain);
    } else {
      throw e;
    }
  }
}

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let idx = remaining.lastIndexOf("\n\n", maxLen);
    if (idx <= 0) idx = remaining.lastIndexOf("\n", maxLen);
    if (idx <= 0) idx = remaining.lastIndexOf(" ", maxLen);
    if (idx <= 0) idx = maxLen;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trim();
  }
  return chunks;
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  const formatted = toTelegramMarkdown(response);
  const MAX = TELEGRAM_MAX_LENGTH;

  if (formatted.length <= MAX) {
    await sendChunk(ctx, formatted, response);
    return;
  }

  const formattedChunks = chunkText(formatted, MAX);
  const plainChunks = chunkText(response, MAX);

  for (let i = 0; i < formattedChunks.length; i++) {
    await sendChunk(ctx, formattedChunks[i], plainChunks[i] ?? formattedChunks[i]);
  }
}

// ── Graceful shutdown ───────────────────────────────────────

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, shutting down gracefully...`);
    setTimeout(() => {
      console.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, 65000).unref();

    // Stop intervals and watchers
    clearInterval(agentCheckInterval);
    clearInterval(outboxCheckInterval);
    outboxWatcher.close();
    agentWatcher.close();

    await bot.stop();

    // Wait up to 60s for children to complete naturally
    if (activeChildPids.size > 0) {
      console.log(`Waiting for ${activeChildPids.size} child processes to complete...`);
      const completed = await waitForChildren(60000);
      if (completed) {
        console.log("All children completed gracefully");
      } else {
        console.log(`Force-killing ${activeChildPids.size} remaining children`);
        await killAllChildren();
      }
    }

    await releaseLock("relay");
    process.exit(0);
  });
}

// ── Watch jobs.json → auto-sync launchd plists ──────────────

let syncTimeout: ReturnType<typeof setTimeout> | null = null;
watch(join(MUAVIN_DIR, "jobs.json"), () => {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => syncJobPlists().catch((e) => console.error("Job sync error:", e)), 1000);
});

// ── Start ───────────────────────────────────────────────────

// Restore any outbox items left in .processing state from a previous crash
await restoreUndeliveredOutbox();

console.log("Starting Muavin relay...");

bot.start().catch((err) => {
  console.error("bot.start() fatal:", err);
  releaseLock("relay").catch(() => {});
  process.exit(1);
});
