import { readFile, writeFile, unlink, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { MUAVIN_DIR, loadJson, loadConfig, reloadService, getUid, formatError } from "./utils";

export const JOB_LABEL_PREFIX = "ai.muavin.job.";
const jobLabel = (id: string) => `${JOB_LABEL_PREFIX}${id}`;
const jobPlistName = (id: string) => `${JOB_LABEL_PREFIX}${id}.plist`;
const jobIdFromPlist = (name: string) => name.slice(JOB_LABEL_PREFIX.length, -".plist".length);

export interface Job {
  id: string;
  name?: string;
  schedule: string;
  action?: string;
  prompt?: string;
  type?: "system" | "default";
  model?: string;
  enabled: boolean;
  skipContext?: boolean;
}

export const DEFAULT_JOBS: Job[] = [
  {
    id: "memory-health",
    name: "Memory health check",
    schedule: "0 9 * * *",
    action: "memory-health",
    type: "system",
    enabled: true,
  },
  {
    id: "memory-extraction",
    name: "Extract memories",
    schedule: "0 */2 * * *",
    action: "extract-memories",
    type: "system",
    enabled: true,
  },
  {
    id: "agent-cleanup",
    name: "Agent cleanup",
    schedule: "0 3 * * *",
    action: "cleanup-agents",
    type: "system",
    enabled: true,
  },
  {
    id: "self-improvement",
    name: "Self-improvement review",
    schedule: "0 4 * * *",
    type: "default",
    model: "opus",
    enabled: true,
    prompt: `Review your own performance and make improvements. Check:

1. Recent conversation messages (last 7 days) for patterns of user corrections, confusion, or frustration
2. Agent delivery logs — any failed or skipped deliveries
3. Job execution logs (~/Library/Logs/muavin-jobs.log) — any failures or bad output
4. Memory store — stale, contradictory, or wrong facts
5. Your prompt templates (~/.muavin/prompts/), docs (~/.muavin/docs/), and identity (~/.muavin/muavin.md) for inaccuracies

For low-risk/obvious fixes (typos, stale facts, clearly wrong info): make the change directly and include what you changed and why in your response.
For risky/significant changes: describe the proposed change and why, but do NOT make it — wait for user approval.

Focus on concrete, specific improvements. Do not make changes for the sake of change.

If nothing needs improvement, respond with exactly: SKIP`,
  },
  {
    id: "autonomous-suggestions",
    name: "Autonomous action suggestions",
    schedule: "0 10 * * *",
    type: "default",
    model: "opus",
    enabled: true,
    prompt: `Review what you know about the user — recent conversations, memories, active projects, goals, and context. Suggest 1-2 actions you can take autonomously (without user involvement) that would genuinely help.

Think ambitiously. You have full command-line access, web search, file system, APIs, and can create agents for long-running tasks. Examples: research a topic they mentioned, set up a monitoring script, organize files, write a comparison doc, automate a repetitive workflow.

Review the message history for your past autonomous suggestions and how the user responded. The semantic memory context may also surface older patterns. Note which types of suggestions were welcomed vs ignored — adapt accordingly. Don't over-index on individual non-responses (the user may have been busy or distracted), but notice trends across multiple deliveries.

Rules:
- Only suggest things you can actually do end-to-end without user input
- Be specific — "I could research X and write up findings" not "I could help with research"
- Prefer high-impact actions over busywork
- 1-2 suggestions max. Quality over quantity.

If nothing useful comes to mind, respond with exactly: SKIP`,
  },
  {
    id: "user-suggestions",
    name: "High-ROI user suggestions",
    schedule: "0 11 * * *",
    type: "default",
    model: "opus",
    enabled: true,
    prompt: `Review what you know about the user — conversations, memories, goals, deadlines, and context. Suggest actions the user could take that are high-ROI and time-sensitive.

Be extremely selective. The user is busy. Only surface things that are:
- Truly worth their attention right now
- High impact relative to effort
- Time-sensitive or have a deadline approaching
- Things you can partially help with or automate

A day with no suggestion is better than a low-value one. If you suggest something, also mention how you can help (e.g., "I can draft the email if you want" or "I can research options while you decide").

Review the message history for your past user suggestions and whether they were acted on or dismissed. The semantic memory context may also reveal older patterns. Adapt based on trends — if certain types were consistently ignored, try different angles. Don't read too much into individual non-responses (busy, distracted, changed priorities), but do learn from repeated patterns.

Max 1 suggestion. If nothing meets the bar, respond with exactly: SKIP`,
  },
];

export function seedDefaultJobs(existing: Job[]): Job[] {
  const result = existing.map((j) => ({ ...j }));
  let added = 0;

  for (const defaultJob of DEFAULT_JOBS) {
    const match = result.find((j) => j.id === defaultJob.id);
    if (!match) {
      result.push({ ...defaultJob });
      added++;
    } else if (!match.type) {
      match.type = defaultJob.type;
    }
  }

  return result;
}

type LaunchdSchedule =
  | { StartCalendarInterval: { Hour: number; Minute: number } }
  | { StartCalendarInterval: Array<{ Hour: number; Minute: number }> };

function expandCronField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (trimmed.startsWith("*/")) {
      const step = parseInt(trimmed.slice(2));
      for (let i = min; i <= max; i += step) values.add(i);
    } else {
      values.add(parseInt(trimmed));
    }
  }
  return [...values].sort((a, b) => a - b);
}

export function cronToLaunchd(schedule: string): LaunchdSchedule {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${schedule}`);
  }

  const [minuteField, hourField] = parts;
  const minutes = expandCronField(minuteField, 0, 59);
  const hours = expandCronField(hourField, 0, 23);

  const intervals = hours.flatMap(h => minutes.map(m => ({ Hour: h, Minute: m })));

  if (intervals.length === 1) {
    return { StartCalendarInterval: intervals[0] };
  }
  return { StartCalendarInterval: intervals };
}

export function generateJobPlist(
  job: { id: string; schedule: string },
  bunPath: string,
  repoRoot: string,
  homeDir: string
): string {
  const label = jobLabel(job.id);
  const schedule = cronToLaunchd(job.schedule);
  const pathEnv = `${homeDir}/.local/bin:${homeDir}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

  const scheduleXml =
    "StartCalendarInterval" in schedule
      ? Array.isArray(schedule.StartCalendarInterval)
        ? `    <key>StartCalendarInterval</key>
    <array>
${schedule.StartCalendarInterval.map(
  (item) => `        <dict>
            <key>Hour</key>
            <integer>${item.Hour}</integer>
            <key>Minute</key>
            <integer>${item.Minute}</integer>
        </dict>`
).join("\n")}
    </array>`
        : `    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${schedule.StartCalendarInterval.Hour}</integer>
        <key>Minute</key>
        <integer>${schedule.StartCalendarInterval.Minute}</integer>
    </dict>`
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bunPath}</string>
        <string>run</string>
        <string>${repoRoot}/src/run-job.ts</string>
        <string>${job.id}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${homeDir}/.muavin</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${pathEnv}</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
${scheduleXml}
    <key>StandardOutPath</key>
    <string>${homeDir}/Library/Logs/muavin-jobs.log</string>
    <key>StandardErrorPath</key>
    <string>${homeDir}/Library/Logs/muavin-jobs.error.log</string>
</dict>
</plist>
`;
}

export async function syncJobPlists(): Promise<void> {
  const allJobs = await loadJson<Job[]>(join(MUAVIN_DIR, "jobs.json"));
  if (!allJobs) {
    console.log("No jobs.json found, skipping job sync");
    return;
  }

  const config = await loadConfig();
  const repoRoot = config.repoPath || process.cwd();
  const homeDir = homedir();
  const bunPath = Bun.which("bun");
  if (!bunPath) {
    throw new Error("bun not found in PATH");
  }

  const uid = await getUid();

  const launchAgentsDir = join(homeDir, "Library/LaunchAgents");
  const allFiles = await readdir(launchAgentsDir).catch(() => []);
  const existingJobPlists = allFiles.filter((f) => f.startsWith(JOB_LABEL_PREFIX));

  const enabledJobs = allJobs.filter((j) => j.enabled);
  const enabledJobIds = new Set(enabledJobs.map((j) => j.id));

  // Sync enabled jobs
  for (const job of enabledJobs) {
    const plistPath = join(launchAgentsDir, jobPlistName(job.id));
    const newContent = generateJobPlist(job, bunPath, repoRoot, homeDir);

    const existingContent = await readFile(plistPath, "utf-8").catch(() => null);
    if (existingContent !== newContent) {
      await writeFile(plistPath, newContent);

      await reloadService(uid, jobLabel(job.id), plistPath);
      console.log(`Synced job: ${job.id}`);
    }
  }

  // Remove disabled/deleted jobs
  for (const plistFile of existingJobPlists) {
    const id = jobIdFromPlist(plistFile);
    if (!enabledJobIds.has(id)) {
      const plistPath = join(launchAgentsDir, plistFile);

      // Bootout
      await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${jobLabel(id)}`], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      // Delete plist
      await unlink(plistPath);
      console.log(`Removed job: ${id}`);
    }
  }
}
