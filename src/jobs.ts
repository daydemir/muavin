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
  description?: string;
  schedule: string;
  action?: string;
  prompt?: string;
  type?: "system" | "default";
  model?: string;
  enabled: boolean;
  skipContext?: boolean;
  timeoutMs?: number;
}

export const DEFAULT_JOBS: Job[] = [
  {
    id: "files-ingest",
    name: "Files inbox ingest",
    schedule: "0 * * * *",
    action: "ingest-files",
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
    id: "clarification-digest",
    name: "Clarification digest",
    schedule: "0 21 * * *",
    action: "clarification-digest",
    type: "system",
    enabled: true,
  },
];

export function seedDefaultJobs(existing: Job[]): Job[] {
  const removedIds = new Set([
    "memory-health",
    "memory-extraction",
    "self-improvement",
    "autonomous-suggestions",
    "user-suggestions",
    "ai-tools-digest",
    "stretch-reminder",
    "urgent-reminders",
    "auto-safe",
    "morning-briefing",
    "product-self-improvement",
  ]);
  const result = existing
    .filter((j) => !removedIds.has(j.id))
    .map((j) => ({ ...j }));
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
  return [...values].filter(v => v >= min && v <= max).sort((a, b) => a - b);
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
  if (intervals.length === 0) {
    throw new Error(`Cron expression "${schedule}" produced no valid intervals`);
  }

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
