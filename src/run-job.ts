import { validateEnv } from "./env";
import { join } from "path";
import { callClaude } from "./claude";
import { runHealthCheck, extractMemories } from "./memory";
import { cleanupAgents, buildContext, cleanupUploads } from "./agents";
import { MUAVIN_DIR, loadConfig, loadJson, saveJson, writeOutbox, isSkipResponse, formatLocalTime } from "./utils";
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

const config = await loadConfig();
const now = new Date();

console.log(`[${jobId}] running...`);

try {
  if (job.action === "memory-health") {
    await runHealthCheck(job.model);
    console.log(`[${jobId}] health check complete`);
  } else if (job.action === "extract-memories") {
    const extracted = await extractMemories(job.model);
    console.log(`[${jobId}] extracted ${extracted} memories`);
  } else if (job.action === "cleanup-agents") {
    const cleanedAgents = await cleanupAgents(7 * 24 * 60 * 60_000);
    const cleanedUploads = await cleanupUploads(24 * 60 * 60_000);
    console.log(`[${jobId}] cleaned ${cleanedAgents} old agent files, ${cleanedUploads} old uploads`);
  } else if (job.action === "auto-safe") {
    const { runAutoSafe } = await import("./auto-safe");
    await runAutoSafe(job, config);
  } else if (job.prompt) {
    const timeStr = formatLocalTime(now);
    const fullPrompt = `[Job: ${jobId}] Time: ${timeStr}\n\n${job.prompt}`;
    const appendSystemPrompt = await buildContext({
      query: job.prompt,
      chatId: config.owner,
      recentCount: config.recentMessageCount ?? 100,
    });
    const result = await callClaude(fullPrompt, {
      noSessionPersistence: true,
      maxTurns: config.jobMaxTurns ?? 100,
      timeoutMs: config.jobTimeoutMs ?? 600000,
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
  // Notify owner of job failure via outbox
  await writeOutbox({
    source: "job",
    sourceId: jobId,
    task: job.name || jobId,
    result: `Job "${job.name || jobId}" failed: ${error instanceof Error ? error.message : String(error)}`,
    chatId: config.owner,
    createdAt: new Date().toISOString(),
  }).catch(e => console.error(`[${jobId}] failed to write error to outbox:`, e));
}

// Update job-state.json
const state = (await loadJson<JobState>(STATE_FILE)) ?? {};
state[jobId] = Date.now();
await saveJson(STATE_FILE, state);

console.log(`[${jobId}] done`);
