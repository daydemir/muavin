import { validateEnv } from "./env";
import { Bot, type Context } from "grammy";
import { writeFile, readFile, mkdir, rename, unlink } from "fs/promises";
import { watch } from "fs";
import { join } from "path";
import { callClaude, killAllChildren } from "./claude";
import { logMessage } from "./memory";
import { buildContext, listAgents, updateAgent, type AgentFile } from "./agents";
import { syncJobPlists } from "./jobs";
import { acquireLock, releaseLock, MUAVIN_DIR, writeOutbox, readOutbox, clearOutboxItems, timestamp } from "./utils";
import { sendAndLog, toTelegramMarkdown } from "./telegram";

validateEnv();

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

// ── Config ──────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const SESSIONS_FILE = join(MUAVIN_DIR, "sessions.json");
const UPLOADS_DIR = join(MUAVIN_DIR, "uploads");

// ── Allow list from config ─────────────────────────────────
const configPath = join(process.env.HOME ?? "~", ".muavin", "config.json");
try {
  await readFile(configPath);
} catch {
  console.error("config.json not found in ~/.muavin/. Run 'bun muavin setup'");
  process.exit(1);
}
const config = JSON.parse(await readFile(configPath, "utf-8"));
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

// ── Per-chat sessions ───────────────────────────────────────

interface SessionState {
  sessionId: string | null;
  updatedAt: string;
}

type SessionMap = Record<string, SessionState>;

async function loadSessions(): Promise<SessionMap> {
  try {
    return JSON.parse(await readFile(SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveSessions(map: SessionMap): Promise<void> {
  const tmpFile = `${SESSIONS_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(map, null, 2));
  await rename(tmpFile, SESSIONS_FILE);
}

function getSession(map: SessionMap, chatId: string): SessionState {
  return map[chatId] ?? { sessionId: null, updatedAt: new Date().toISOString() };
}

const sessions = await loadSessions();

// ── Message queue (two-array queue) ─────────────────────────

const userQueue: Array<{ ctx: Context; prompt: string }> = [];
const outboxQueue: Array<"check"> = [];
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
        await processUserMessage(item.ctx, item.prompt);
      }

      // If no user messages, process one outbox item
      if (outboxQueue.length > 0) {
        outboxQueue.shift();
        await processOutbox();
      } else {
        // Both queues empty
        break;
      }
    }
  } finally {
    processing = false;
  }
}

async function processUserMessage(ctx: Context, prompt: string): Promise<void> {
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);

  try {
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
    const timeStr = now.toLocaleString("en-US", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

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

    // Log messages async (don't block reply)
    logMessage("user", prompt, chatId).catch(e => console.error('logMessage failed:', e));
    logMessage("assistant", result.text, chatId).catch(e => console.error('logMessage failed:', e));

    await sendResponse(ctx, result.text);
  } catch (error) {
    console.error("Error in processUserMessage:", error);
    await ctx.reply(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  } finally {
    clearInterval(typingInterval);
  }
}

async function processOutbox(): Promise<void> {
  try {
    // Read outbox items
    const outboxItems = await readOutbox();
    if (outboxItems.length === 0) return;

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

    const prompt = `You have ${outboxItems.length} pending result(s) to deliver:\n\n${itemsList}\n\nReview these results and deliver them to me. If they are not worth delivering (e.g., redundant, not interesting, or already covered), respond with exactly "SKIP" to dismiss them.`;

    // Call Claude (no session)
    const result = await callClaude(prompt, {
      appendSystemPrompt,
      timeoutMs: config.relayTimeoutMs ?? 600000,
      maxTurns: config.relayMaxTurns ?? 100,
      noSessionPersistence: true,
    });

    // Check if Claude wants to skip
    if (result.text.trim() === "SKIP") {
      console.log(timestamp("relay"), "Outbox delivery skipped by voice");
      await clearOutboxItems(outboxItems.map(i => i._filename));
      return;
    }

    // Send to owner
    const success = await sendAndLog(config.owner, result.text, { parseMode: "Markdown" });
    if (success) {
      console.log(timestamp("relay"), `Delivered ${outboxItems.length} outbox item(s) to owner`);
    }

    // Clear outbox items
    await clearOutboxItems(outboxItems.map(i => i._filename));
  } catch (error) {
    console.error(timestamp("relay"), "Error in processOutbox:", error);
  }
}

// ── Agent processing (background) ───────────────────────────

const agentConcurrency = config.agentConcurrency ?? 10;
let runningAgentCount = 0;

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

    // Write to outbox
    await writeOutbox({
      source: "agent",
      sourceId: agent.id,
      task: agent.task,
      result: result.text,
      chatId: agent.chatId,
      createdAt: new Date().toISOString(),
    });

    // Push to outbox queue for voice processing
    outboxQueue.push("check");
    scheduleQueue();
  } catch (error) {
    // Mark as failed
    const errorMsg = error instanceof Error ? error.message : String(error);
    await updateAgent(agent.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: errorMsg,
    }, agent._filename);

    console.error(timestamp("relay"), `Agent ${agent.id} failed:`, errorMsg);

    // Write error to outbox
    await writeOutbox({
      source: "agent",
      sourceId: agent.id,
      task: agent.task,
      result: `Agent failed: ${errorMsg}`,
      chatId: agent.chatId,
      createdAt: new Date().toISOString(),
    });

    // Push to outbox queue
    outboxQueue.push("check");
    scheduleQueue();
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
      if (lastStatusAt > 0 && now - lastStatusAt > 5 * 60 * 1000) {
        const elapsed = Math.round((now - startedAt) / 1000 / 60);
        console.log(timestamp("relay"), `Agent ${agent.id} running for ${elapsed}m (stale status)`);

        await writeOutbox({
          source: "agent",
          sourceId: agent.id,
          task: agent.task,
          result: `Agent "${agent.task}" still running (${elapsed}m elapsed)`,
          chatId: agent.chatId,
          createdAt: new Date().toISOString(),
        });

        // Update lastStatusAt
        await updateAgent(agent.id, {
          lastStatusAt: new Date().toISOString(),
        }, agent._filename);
      }

      // Check for stuck agents (>2h with dead PID)
      if (startedAt > 0 && now - startedAt > 2 * 60 * 60 * 1000) {
        // Check if PID is alive (simple check, not foolproof)
        let pidAlive = false;
        if (agent.pid) {
          try {
            process.kill(agent.pid, 0); // signal 0 just checks if process exists
            pidAlive = true;
          } catch {
            pidAlive = false;
          }
        }

        if (!pidAlive) {
          console.log(timestamp("relay"), `Agent ${agent.id} stuck (>2h, dead PID), marking as failed`);

          await updateAgent(agent.id, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: "Agent stuck (>2h with dead PID)",
          }, agent._filename);

          await writeOutbox({
            source: "agent",
            sourceId: agent.id,
            task: agent.task,
            result: `Agent "${agent.task}" stuck and marked as failed`,
            chatId: agent.chatId,
            createdAt: new Date().toISOString(),
          });
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
    outboxQueue.push("check");
    scheduleQueue();
  }, 2000);
});

// ── Agent directory watcher ─────────────────────────────────

let agentDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const AGENTS_DIR = join(MUAVIN_DIR, "agents");

const agentWatcher = watch(AGENTS_DIR, () => {
  if (agentDebounceTimer) clearTimeout(agentDebounceTimer);
  agentDebounceTimer = setTimeout(() => {
    checkPendingAgents().catch(e => console.error("checkPendingAgents error:", e));
  }, 1000);
});

// ── Agent check interval ────────────────────────────────────

const agentCheckInterval = setInterval(() => {
  checkPendingAgents().catch(e => console.error("checkPendingAgents error:", e));
  checkRunningAgents().catch(e => console.error("checkRunningAgents error:", e));
}, 30000);

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

// ── Commands ────────────────────────────────────────────────

bot.command("new", async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "unknown");
  sessions[chatId] = { sessionId: null, updatedAt: new Date().toISOString() };
  await saveSessions(sessions);
  await ctx.reply("Fresh session started.");
});

bot.command("status", async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "unknown");
  const session = getSession(sessions, chatId);
  await ctx.reply(
    `Session: ${session.sessionId ? session.sessionId.slice(0, 8) + "..." : "none"}\n` +
      `Last activity: ${session.updatedAt}`,
  );
});

// ── Core message handler ────────────────────────────────────

async function handleMessage(ctx: Context, prompt: string): Promise<void> {
  await ctx.replyWithChatAction("typing");
  userQueue.push({ ctx, prompt });
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

  await handleMessage(ctx, text);
});

// ── Photos ──────────────────────────────────────────────────

bot.on("message:photo", async (ctx) => {
  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    const filePath = join(UPLOADS_DIR, `photo_${Date.now()}.jpg`);
    const res = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
    );
    await writeFile(filePath, Buffer.from(await res.arrayBuffer()));

    const caption = ctx.message.caption || "Analyze this image.";
    await handleMessage(ctx, `[User sent a file: ${filePath}] ${caption}`);
    await unlink(filePath).catch(() => {});
  } catch (error) {
    console.error("Photo error:", error);
    await ctx.reply("Could not process photo.");
  }
});

// ── Documents ───────────────────────────────────────────────

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  try {
    const file = await ctx.getFile();
    const fileName = doc.file_name || `file_${Date.now()}`;
    const filePath = join(UPLOADS_DIR, `${Date.now()}_${fileName}`);

    const res = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
    );
    await writeFile(filePath, Buffer.from(await res.arrayBuffer()));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    await handleMessage(ctx, `[User sent a file: ${filePath}] ${caption}`);
    await unlink(filePath).catch(() => {});
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ── Voice (not yet supported) ───────────────────────────────

bot.on("message:voice", async (ctx) => {
  await ctx.reply(
    "Voice messages not yet supported — type your message instead.",
  );
});

// ── Response chunking ───────────────────────────────────────

async function sendChunk(ctx: Context, text: string): Promise<void> {
  text = toTelegramMarkdown(text);
  try {
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch (e: any) {
    if (e?.description?.includes("can't parse") || e?.error_code === 400) {
      console.log("Markdown parse failed, retrying without parse_mode");
      await ctx.reply(text);
    } else {
      throw e;
    }
  }
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  if (!response.trim()) {
    throw new Error("Claude returned an empty response");
  }
  const MAX = 4000;
  if (response.length <= MAX) {
    await sendChunk(ctx, response);
    return;
  }

  let remaining = response;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      await sendChunk(ctx, remaining);
      break;
    }
    let idx = remaining.lastIndexOf("\n\n", MAX);
    if (idx <= 0) idx = remaining.lastIndexOf("\n", MAX);
    if (idx <= 0) idx = remaining.lastIndexOf(" ", MAX);
    if (idx <= 0) idx = MAX;

    await sendChunk(ctx, remaining.slice(0, idx));
    remaining = remaining.slice(idx).trim();
  }
}

// ── Graceful shutdown ───────────────────────────────────────

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, shutting down...`);

    // Stop intervals and watchers
    clearInterval(agentCheckInterval);
    outboxWatcher.close();
    agentWatcher.close();

    await bot.stop();
    await killAllChildren();
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

console.log("Starting Muavin relay...");

bot.start().catch((err) => {
  console.error("bot.start() fatal:", err);
  releaseLock("relay").catch(() => {});
  process.exit(1);
});
