import { readFile, writeFile, unlink, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { MUAVIN_DIR, loadJson, loadConfig, reloadService } from "./utils";

export interface Job {
  id: string;
  name?: string;
  schedule: string;
  action?: string;
  prompt?: string;
  type?: "system" | "default";
  enabled: boolean;
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
    enabled: true,
    prompt: `Review what you know about the user — recent conversations, memories, active projects, goals, and context. Suggest 1-2 actions you can take autonomously (without user involvement) that would genuinely help.

Think ambitiously. You have full command-line access, web search, file system, APIs, and can create agents for long-running tasks. Examples: research a topic they mentioned, set up a monitoring script, organize files, write a comparison doc, automate a repetitive workflow.

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
    enabled: true,
    prompt: `Review what you know about the user — conversations, memories, goals, deadlines, and context. Suggest actions the user could take that are high-ROI and time-sensitive.

Be extremely selective. The user is busy. Only surface things that are:
- Truly worth their attention right now
- High impact relative to effort
- Time-sensitive or have a deadline approaching
- Things you can partially help with or automate

A day with no suggestion is better than a low-value one. If you suggest something, also mention how you can help (e.g., "I can draft the email if you want" or "I can research options while you decide").

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

export function cronToLaunchd(schedule: string): LaunchdSchedule {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${schedule}`);
  }

  const [minute, hour] = parts;

  // Fixed-time pattern: "0 9 * * *"
  if (!hour.includes("/") && !minute.includes("/")) {
    return {
      StartCalendarInterval: {
        Hour: parseInt(hour),
        Minute: parseInt(minute),
      },
    };
  }

  // Interval pattern: "0 */2 * * *"
  if (hour.includes("*/")) {
    const intervalMatch = hour.match(/^\*\/(\d+)$/);
    if (!intervalMatch) {
      throw new Error(`Unsupported hour pattern: ${hour}`);
    }
    const interval = parseInt(intervalMatch[1]);
    const minuteValue = parseInt(minute);
    const hours: Array<{ Hour: number; Minute: number }> = [];
    for (let h = 0; h < 24; h += interval) {
      hours.push({ Hour: h, Minute: minuteValue });
    }
    return { StartCalendarInterval: hours };
  }

  throw new Error(`Unsupported cron pattern: ${schedule}`);
}

export function generateJobPlist(
  job: { id: string; schedule: string },
  bunPath: string,
  repoRoot: string,
  homeDir: string
): string {
  const label = `ai.muavin.job.${job.id}`;
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

  const uidProc = Bun.spawn(["id", "-u"], { stdout: "pipe" });
  const uidText = await new Response(uidProc.stdout).text();
  const uid = uidText.trim();

  const launchAgentsDir = join(homeDir, "Library/LaunchAgents");
  const allFiles = await readdir(launchAgentsDir).catch(() => []);
  const existingJobPlists = allFiles.filter((f) => f.startsWith("ai.muavin.job."));

  const enabledJobs = allJobs.filter((j) => j.enabled);
  const enabledJobIds = new Set(enabledJobs.map((j) => j.id));

  // Sync enabled jobs
  for (const job of enabledJobs) {
    const plistName = `ai.muavin.job.${job.id}.plist`;
    const plistPath = join(launchAgentsDir, plistName);
    const newContent = generateJobPlist(job, bunPath, repoRoot, homeDir);

    const existingContent = await readFile(plistPath, "utf-8").catch(() => null);
    if (existingContent !== newContent) {
      await writeFile(plistPath, newContent);

      const label = `ai.muavin.job.${job.id}`;
      await reloadService(uid, label, plistPath);
      console.log(`Synced job: ${job.id}`);
    }
  }

  // Remove disabled/deleted jobs
  for (const plistName of existingJobPlists) {
    const jobId = plistName.replace("ai.muavin.job.", "").replace(".plist", "");
    if (!enabledJobIds.has(jobId)) {
      const plistPath = join(launchAgentsDir, plistName);
      const label = `ai.muavin.job.${jobId}`;

      // Bootout
      await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${label}`], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      // Delete plist
      await unlink(plistPath);
      console.log(`Removed job: ${jobId}`);
    }
  }
}
