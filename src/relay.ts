import { validateEnv } from "./env";
import { Bot, type Context } from "grammy";
import { writeFile, readFile, unlink, mkdir, rename } from "fs/promises";
import { watch } from "fs";
import { join } from "path";
import { callClaude } from "./claude";
import { logMessage } from "./memory";
import { buildContext } from "./agents";
import { syncJobPlists } from "./jobs";

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
  return new Promise((resolve, reject) => {
    queue.push(async () => {
      try {
        await fn();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    processQueue();
  });
}

async function processQueue(): Promise<void> {
  if (processing) {
    return;
  }
  processing = true;
  while (queue.length > 0) {
    const task = queue.shift()!;
    await task();
  }
  processing = false;
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
  await ctx.replyWithChatAction("typing");

  await enqueue(async () => {
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
      console.error("Error in handleMessage:", error);
      await ctx.reply(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      clearInterval(typingInterval);
    }
  });
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

async function sendResponse(ctx: Context, response: string): Promise<void> {
  const MAX = 4000;
  if (response.length <= MAX) {
    await ctx.reply(response, { parse_mode: "Markdown" });
    return;
  }

  let remaining = response;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      await ctx.reply(remaining, { parse_mode: "Markdown" });
      break;
    }
    let idx = remaining.lastIndexOf("\n\n", MAX);
    if (idx <= 0) idx = remaining.lastIndexOf("\n", MAX);
    if (idx <= 0) idx = remaining.lastIndexOf(" ", MAX);
    if (idx <= 0) idx = MAX;

    await ctx.reply(remaining.slice(0, idx), { parse_mode: "Markdown" });
    remaining = remaining.slice(idx).trim();
  }
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
  unlink(LOCK_FILE).catch(() => {});
  process.exit(1);
});
