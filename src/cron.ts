import { Cron } from "croner";
import { validateEnv } from "./env";
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { join } from "path";
import { callClaude } from "./claude";
import { syncMemoryMd, runHealthCheck, extractMemories } from "./memory";

validateEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const MUAVIN_DIR = join(process.env.HOME ?? "~", ".muavin");
const STATE_FILE = join(MUAVIN_DIR, "cron-state.json");

await mkdir(MUAVIN_DIR, { recursive: true });

interface CronJob {
  id: string;
  prompt?: string;
  action?: string;
  schedule: string;
}

interface CronState {
  [jobId: string]: number; // last run timestamp
}

async function loadState(): Promise<CronState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveState(state: CronState): Promise<void> {
  const tmpPath = STATE_FILE + ".tmp";
  await writeFile(tmpPath, JSON.stringify(state, null, 2));
  await rename(tmpPath, STATE_FILE);
}

async function sendTelegram(text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.owner,
      text,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`sendTelegram failed: ${res.status} ${body}`);
  }
}

// Main
const configPath = join(process.env.HOME ?? "~", ".muavin", "config.json");
try {
  await readFile(configPath);
} catch {
  console.error("config.json not found in ~/.muavin/. Run 'bun muavin setup'");
  process.exit(1);
}
const config = JSON.parse(await readFile(configPath, "utf-8"));
const jobs: CronJob[] = config.cron;
const state = await loadState();
const now = new Date();

for (const job of jobs) {
  const lastRun = state[job.id] ?? 0;
  const cron = new Cron(job.schedule);
  const nextAfterLast = cron.nextRun(new Date(lastRun));

  if (!nextAfterLast || nextAfterLast > now) {
    const next = cron.nextRun();
    console.log(`${job.id}: not due (next: ${next?.toLocaleString() ?? "never"})`);
    continue;
  }

  console.log(`${job.id}: running...`);

  try {
    if (job.action === "sync-memory") {
      const synced = await syncMemoryMd(process.cwd());
      console.log(`${job.id}: synced ${synced} memory entries`);
    } else if (job.action === "memory-health") {
      await runHealthCheck();
      console.log(`${job.id}: health check complete`);
    } else if (job.action === "extract-memories") {
      const extracted = await extractMemories();
      console.log(`${job.id}: extracted ${extracted} memories`);
    } else if (job.prompt) {
      const timeStr = now.toLocaleString("en-US", {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const fullPrompt = `[Cron: ${job.id}] Time: ${timeStr}\n\n${job.prompt}`;
      const result = await callClaude(fullPrompt, {
        noSessionPersistence: true,
        maxTurns: 5,
      });

      if (result.text.trim() === "SKIP") {
        console.log(`${job.id}: SKIP`);
      } else {
        await sendTelegram(result.text);
        console.log(`${job.id}: sent to Telegram`);
      }
    }
  } catch (error) {
    console.error(`${job.id} error:`, error);
  }

  state[job.id] = Date.now();
}

await saveState(state);
console.log("Cron run complete.");
