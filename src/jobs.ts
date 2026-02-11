import { readFile, writeFile, unlink, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { MUAVIN_DIR, loadJson, loadConfig } from "./utils";

interface Job {
  id: string;
  schedule: string;
  enabled: boolean;
  [key: string]: unknown;
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

      // Bootout if already loaded
      const label = `ai.muavin.job.${job.id}`;
      await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${label}`], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      // Bootstrap
      await Bun.spawn(["launchctl", "bootstrap", `gui/${uid}`, plistPath], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

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
