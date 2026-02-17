import { validateEnv } from "./env";
import { join } from "path";
import { callClaude } from "./claude";
import { runHealthCheck, extractMemories } from "./memory";
import { cleanupAgents, buildContext, cleanupUploads } from "./agents";
import { MUAVIN_DIR, loadConfig, loadJson, saveJson, writeOutbox, isSkipResponse, formatLocalTime, formatError, acquireLock, releaseLock, type Config } from "./utils";
import type { Job } from "./jobs";

validateEnv();

const jobId = Bun.argv[2];
if (!jobId) {
  console.error("Usage: run-job.ts <jobId>");
  process.exit(1);
}

interface JobState {
  [jobId: string]: number;
}

const JOBS_PATH = join(MUAVIN_DIR, "jobs.json");
const STATE_FILE = join(MUAVIN_DIR, "job-state.json");

const allJobs = await loadJson<Job[]>(JOBS_PATH);
if (!allJobs) {
  console.log(`[${jobId}] jobs.json not found, exiting`);
  process.exit(0);
}

const job = allJobs.find((j) => j.id === jobId);
if (!job || !job.enabled) {
  console.log(`[${jobId}] job not found or disabled, exiting`);
  process.exit(0);
}

// Prevent overlapping runs of the same job
if (!(await acquireLock(`job-${jobId}`))) {
  console.log(`[${jobId}] already running, skipping`);
  process.exit(0);
}

const config = await loadConfig();
const now = new Date();

console.log(`[${jobId}] running...`);

type ActionHandler = (job: Job, config: Config) => Promise<void>;

const actions: Record<string, ActionHandler> = {
  "memory-health": async (job) => {
    await runHealthCheck(job.model);
    console.log(`[${job.id}] health check complete`);
  },
  "extract-memories": async (job) => {
    const extracted = await extractMemories(job.model);
    console.log(`[${job.id}] extracted ${extracted} memories`);
  },
  "cleanup-agents": async (job, config) => {
    const retentionDays = config.cleanupRetentionDays ?? 7;
    const cleanedAgents = await cleanupAgents(retentionDays * 24 * 60 * 60_000);
    const cleanedUploads = await cleanupUploads(24 * 60 * 60_000);
    console.log(`[${job.id}] cleaned ${cleanedAgents} old agent files, ${cleanedUploads} old uploads`);
  },
};

try {
  const handler = job.action ? actions[job.action] : undefined;

  if (handler) {
    await handler(job, config);
  } else if (job.prompt) {
    const timeStr = formatLocalTime(now);
    const fullPrompt = `[Job: ${jobId}] Time: ${timeStr}\n\n${job.prompt}`;
    const appendSystemPrompt = job.skipContext
      ? ""
      : await buildContext({
          query: job.prompt,
          chatId: config.owner,
          recentCount: config.recentMessageCount ?? 100,
        });
    const result = await callClaude(fullPrompt, {
      noSessionPersistence: true,
      maxTurns: config.jobMaxTurns ?? 100,
      timeoutMs: job.timeoutMs ?? config.jobTimeoutMs ?? 600000,
      appendSystemPrompt,
      model: job.model,
    });

    if (isSkipResponse(result.text)) {
      console.log(`[${jobId}] SKIP`);
    } else {
      await writeOutbox({
        source: "job",
        sourceId: jobId,
        task: job.name || jobId,
        result: result.text,
        chatId: config.owner,
        createdAt: new Date().toISOString(),
      });
      console.log(`[${jobId}] wrote to outbox`);
    }
  }
} catch (error) {
  console.error(`[${jobId}] error:`, error);
  await writeOutbox({
    source: "job",
    sourceId: jobId,
    task: job.name || jobId,
    result: `Job "${job.name || jobId}" failed: ${formatError(error)}`,
    chatId: config.owner,
    createdAt: new Date().toISOString(),
  }).catch(e => console.error(`[${jobId}] failed to write error to outbox:`, e));
}

// Update job-state.json (locked to prevent concurrent read-modify-write)
const locked = (await acquireLock("job-state")) || (await Bun.sleep(100).then(() => acquireLock("job-state")));
if (locked) {
  try {
    const state = (await loadJson<JobState>(STATE_FILE)) ?? {};
    state[jobId] = Date.now();
    await saveJson(STATE_FILE, state);
  } finally {
    await releaseLock("job-state");
  }
}

await releaseLock(`job-${jobId}`);

console.log(`[${jobId}] done`);
