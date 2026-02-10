import { Cron } from "croner";
import { validateEnv } from "./env";
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { join } from "path";
import { callClaude } from "./claude";
import { syncMemoryMd, runHealthCheck, extractMemories } from "./memory";
import { sendTelegram } from "./telegram";
import { cleanupAgents, buildSessionContext } from "./agents";

validateEnv();

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

// Main
const configPath = join(process.env.HOME ?? "~", ".muavin", "config.json");
try {
  await readFile(configPath);
} catch {
  console.error("config.json not found in ~/.muavin/. Run 'bun muavin setup'");
  process.exit(1);
}
const config = JSON.parse(await readFile(configPath, "utf-8"));

// Load system jobs from config
const systemJobs: CronJob[] = config.cron;

// Load user jobs from jobs.json
const JOBS_PATH = join(MUAVIN_DIR, "jobs.json");
let userJobs: CronJob[] = [];
try {
  const raw = JSON.parse(await readFile(JOBS_PATH, "utf-8"));
  userJobs = (raw as Array<{ id: string; name?: string; schedule: string; prompt: string; enabled?: boolean }>)
    .filter(j => j.enabled !== false)
    .map(j => ({ id: j.id, schedule: j.schedule, prompt: j.prompt }));
} catch {
  // jobs.json doesn't exist yet, that's fine
}

const jobs: CronJob[] = [...systemJobs, ...userJobs];
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
    } else if (job.action === "cleanup-agents") {
      const cleaned = await cleanupAgents(7 * 24 * 60 * 60_000); // 7 days
      console.log(`${job.id}: cleaned ${cleaned} old agent files`);
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
      const sessionContext = await buildSessionContext();
      const result = await callClaude(fullPrompt, {
        noSessionPersistence: true,
        maxTurns: 5,
        timeoutMs: config.claudeTimeoutMs,
        appendSystemPrompt: sessionContext,
      });

      if (result.text.trim() === "SKIP") {
        console.log(`${job.id}: SKIP`);
      } else {
        await sendTelegram(config.owner, result.text, { parseMode: "Markdown" });
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
