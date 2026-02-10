import { validateEnv } from "./env";
import { Bot, type Context } from "grammy";
import { writeFile, readFile, unlink, mkdir, rename } from "fs/promises";
import { join } from "path";
import { callClaude } from "./claude";
import { logMessage, searchContext } from "./memory";
import { buildSessionContext } from "./agents";

validateEnv();

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

// ── Config ──────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const MUAVIN_DIR = join(process.env.HOME ?? "~", ".muavin");
const SESSIONS_FILE = join(MUAVIN_DIR, "sessions.json");
const LOCK_FILE = join(MUAVIN_DIR, "relay.lock");
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

// ── Lock file ───────────────────────────────────────────────

async function acquireLock(): Promise<boolean> {
  try {
    const existing = await readFile(LOCK_FILE, "utf-8").catch(() => null);
    if (existing) {
      const pid = parseInt(existing);
      try {
        process.kill(pid, 0);
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log(`Stale lock detected (PID: ${pid}), removing lock file`);
        await unlink(LOCK_FILE);
      }
    }
    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch {
    return false;
  }
}

if (!(await acquireLock())) {
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

// ── Message queue (prevent concurrent Claude spawns) ────────

const queue: Array<() => Promise<void>> = [];
let processing = false;

async function enqueue(fn: () => Promise<void>): Promise<void> {
  const timestamp = () => `[relay ${new Date().toISOString()}]`;
  return new Promise((resolve, reject) => {
    queue.push(async () => {
      try {
        await fn();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    console.log(`${timestamp()} Task enqueued, queue length: ${queue.length}`);
    processQueue();
  });
}

async function processQueue(): Promise<void> {
  const timestamp = () => `[relay ${new Date().toISOString()}]`;
  if (processing) {
    console.log(`${timestamp()} processQueue: already processing, returning`);
    return;
  }
  processing = true;
  console.log(`${timestamp()} processQueue: starting, queue length: ${queue.length}`);
  while (queue.length > 0) {
    const task = queue.shift()!;
    console.log(`${timestamp()} processQueue: executing task, ${queue.length} remaining`);
    await task();
    console.log(`${timestamp()} processQueue: task completed`);
  }
  processing = false;
  console.log(`${timestamp()} processQueue: finished, queue empty`);
}

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
  const timestamp = () => `[relay ${new Date().toISOString()}]`;
  const startTime = Date.now();

  console.log(`${timestamp()} handleMessage entered with prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}`);
  console.log(`${timestamp()} Sending initial typing action`);

  await ctx.replyWithChatAction("typing");

  console.log(`${timestamp()} Enqueueing task`);

  await enqueue(async () => {
    console.log(`${timestamp()} Task started in queue`);
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    try {
      // Search for relevant past context
      console.log(`${timestamp()} Searching context for prompt`);
      const contextStartTime = Date.now();
      const contextResults = await searchContext(prompt, 3).catch(() => []);
      const contextElapsed = Date.now() - contextStartTime;
      console.log(`${timestamp()} Context search completed in ${contextElapsed}ms, found ${contextResults.length} results`);

      let appendSystemPrompt: string | undefined;

      if (contextResults.length > 0) {
        const contextStr = contextResults
          .map((r) => `[${r.source}] ${r.content}`)
          .join("\n");
        appendSystemPrompt = `Relevant past context:\n${contextStr}`;
        console.log(`${timestamp()} Using appendSystemPrompt with ${contextStr.length} chars`);
      }

      const sessionContext = await buildSessionContext();
      if (sessionContext) {
        appendSystemPrompt = (appendSystemPrompt ? appendSystemPrompt + "\n\n" : "") + sessionContext;
      }

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
      const numericChatId = ctx.chat?.id ?? 0;
      let fullPrompt = `Current time: ${timeStr}\nChannel: ${chatType}`;
      if (chatType !== "private") {
        fullPrompt += `\nSender: ${senderName}\nNote: Address ${senderName} by name. Be concise in group chats.`;
      }
      fullPrompt += `\n\n${prompt}`;
      fullPrompt += `\nChatId: ${numericChatId}`;

      console.log(`${timestamp()} Full prompt built (${fullPrompt.length} chars): ${fullPrompt.slice(0, 300)}${fullPrompt.length > 300 ? '...' : ''}`);

      const chatId = String(ctx.chat?.id ?? "unknown");
      const session = getSession(sessions, chatId);

      console.log(`${timestamp()} Session state: chatId=${chatId}, sessionId=${session.sessionId?.slice(0, 8) ?? 'null'}, updatedAt=${session.updatedAt}`);
      console.log(`${timestamp()} Calling callClaude with timeout=${config.claudeTimeoutMs}ms`);

      const claudeStartTime = Date.now();
      const result = await callClaude(fullPrompt, {
        resume: session.sessionId ?? undefined,
        appendSystemPrompt,
        timeoutMs: config.claudeTimeoutMs,
      });
      const claudeElapsed = Date.now() - claudeStartTime;

      console.log(`${timestamp()} callClaude returned in ${claudeElapsed}ms: text length=${result.text.length}, sessionId=${result.sessionId.slice(0, 8)}, cost=$${result.costUsd.toFixed(4)}, duration=${result.durationMs}ms`);

      // Save session
      console.log(`${timestamp()} Saving session state`);
      sessions[chatId] = {
        sessionId: result.sessionId,
        updatedAt: new Date().toISOString(),
      };
      await saveSessions(sessions);
      console.log(`${timestamp()} Session saved`);

      // Log messages async (don't block reply)
      console.log(`${timestamp()} Logging messages to memory`);
      logMessage("user", prompt, chatId).catch(e => console.error('logMessage failed:', e));
      logMessage("assistant", result.text, chatId).catch(e => console.error('logMessage failed:', e));

      console.log(`${timestamp()} Sending response (${result.text.length} chars)`);
      await sendResponse(ctx, result.text);

      const totalElapsed = Date.now() - startTime;
      console.log(`${timestamp()} handleMessage completed in ${totalElapsed}ms total`);
    } catch (error) {
      console.error(`${timestamp()} ERROR in handleMessage:`, error);
      if (error instanceof Error) {
        console.error(`${timestamp()} Error stack:`, error.stack);
      }
      await ctx.reply(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      clearInterval(typingInterval);
      console.log(`${timestamp()} Typing interval cleared`);
    }
  });

  console.log(`${timestamp()} handleMessage enqueue promise resolved`);
}

// ── Text messages ───────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.slice(0, 80)}`);

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
  console.log("Photo received");
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
  console.log(`Document: ${doc.file_name}`);
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

async function sendResponse(ctx: Context, response: string): Promise<void> {
  const timestamp = () => `[relay ${new Date().toISOString()}]`;
  console.log(`${timestamp()} sendResponse called with ${response.length} chars`);

  const MAX = 4000;
  if (response.length <= MAX) {
    console.log(`${timestamp()} Sending single message`);
    await ctx.reply(response, { parse_mode: "Markdown" });
    console.log(`${timestamp()} Message sent successfully`);
    return;
  }

  console.log(`${timestamp()} Message exceeds ${MAX} chars, chunking`);
  let remaining = response;
  let chunkNum = 0;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      console.log(`${timestamp()} Sending final chunk ${++chunkNum}`);
      await ctx.reply(remaining, { parse_mode: "Markdown" });
      console.log(`${timestamp()} Final chunk sent`);
      break;
    }
    let idx = remaining.lastIndexOf("\n\n", MAX);
    if (idx <= 0) idx = remaining.lastIndexOf("\n", MAX);
    if (idx <= 0) idx = remaining.lastIndexOf(" ", MAX);
    if (idx <= 0) idx = MAX;

    console.log(`${timestamp()} Sending chunk ${++chunkNum} (${idx} chars)`);
    await ctx.reply(remaining.slice(0, idx), { parse_mode: "Markdown" });
    remaining = remaining.slice(idx).trim();
    console.log(`${timestamp()} Chunk ${chunkNum} sent, ${remaining.length} chars remaining`);
  }
  console.log(`${timestamp()} sendResponse completed, sent ${chunkNum} chunks`);
}

// ── Graceful shutdown ───────────────────────────────────────

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, shutting down...`);
    await bot.stop();
    await unlink(LOCK_FILE).catch(() => {});
    process.exit(0);
  });
}

// ── Start ───────────────────────────────────────────────────

console.log("Starting Muavin relay...");
console.log(`Allowed users: ${[...allowUsers].join(", ")}`);
console.log(`Allowed groups: ${[...allowGroups].join(", ")}`);

bot.start({
  onStart: () => console.log("Muavin is running!"),
}).catch((err) => {
  console.error("bot.start() fatal:", err);
  unlink(LOCK_FILE).catch(() => {});
  process.exit(1);
});
