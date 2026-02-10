import { Cron } from "croner";
import { validateEnv } from "./env";
import { mkdir } from "fs/promises";
import { join } from "path";
import { callClaude } from "./claude";
import { runHealthCheck, extractMemories } from "./memory";
import { sendTelegram } from "./telegram";
import { cleanupAgents, buildContext } from "./agents";
import { MUAVIN_DIR, loadConfig, loadJson, saveJson } from "./utils";

validateEnv();

const STATE_FILE = join(MUAVIN_DIR, "cron-state.json");

await mkdir(MUAVIN_DIR, { recursive: true });

interface Job {
  id: string;
  name: string;
  schedule: string;
  action?: string;
  prompt?: string;
  system?: boolean;
  enabled: boolean;
}

interface CronState {
  [jobId: string]: number; // last run timestamp
}

// Main
const config = await loadConfig();

// Load all jobs from jobs.json
const JOBS_PATH = join(MUAVIN_DIR, "jobs.json");
const allJobs = await loadJson<Job[]>(JOBS_PATH);
if (!allJobs) {
  console.error("jobs.json not found in ~/.muavin/");
  process.exit(1);
}

// Filter enabled jobs only
const jobs = allJobs.filter(j => j.enabled);
const state = await loadJson<CronState>(STATE_FILE) ?? {};
const now = new Date();

for (const job of jobs) {
  const lastRun = state[job.id] ?? 0;
  let cron: Cron;
  try {
    cron = new Cron(job.schedule);
  } catch (err) {
    console.error(`${job.id}: invalid schedule "${job.schedule}":`, err);
    continue;
  }
  const nextAfterLast = cron.nextRun(new Date(lastRun));

  if (!nextAfterLast || nextAfterLast > now) {
    const next = cron.nextRun();
    console.log(`${job.id}: not due (next: ${next?.toLocaleString() ?? "never"})`);
    continue;
  }

  console.log(`${job.id}: running...`);

  try {
    if (job.action === "memory-health") {
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
      const appendSystemPrompt = await buildContext({ query: job.prompt });
      const result = await callClaude(fullPrompt, {
        noSessionPersistence: true,
        maxTurns: 5,
        timeoutMs: config.claudeTimeoutMs,
        appendSystemPrompt,
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

await saveJson(STATE_FILE, state);
console.log("Cron run complete.");
