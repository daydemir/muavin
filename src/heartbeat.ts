import { validateEnv } from "./env";
validateEnv();

import { createClient } from "@supabase/supabase-js";
import { Bot } from "grammy";
import { readFile, writeFile, stat, mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { sendTelegram } from "./telegram";
import { listAgents, updateAgent } from "./agents";
import { runLLM } from "./llm";
import { MUAVIN_DIR, loadConfig, writeOutbox, isSkipResponse, isPidAlive, formatError } from "./utils";
import { EMBEDDING_DIMS, EMBEDDING_MODEL } from "./constants";

const STATE_PATH = join(MUAVIN_DIR, "heartbeat-state.json");

interface HeartbeatState {
  lastRun: number;
  lastAlertText: string;
  lastAlertAt: number;
  lastFailuresHash: string;
  consecutiveFailures: Record<string, number>;
}

async function loadState(): Promise<HeartbeatState> {
  try {
    const raw = JSON.parse(await readFile(STATE_PATH, "utf-8"));
    const state = { lastRun: 0, lastAlertText: "", lastAlertAt: 0, lastFailuresHash: "", consecutiveFailures: {}, ...raw };
    if (typeof state.consecutiveFailures !== "object" || Array.isArray(state.consecutiveFailures) || state.consecutiveFailures === null) {
      state.consecutiveFailures = {};
    }
    return state;
  } catch {
    return { lastRun: 0, lastAlertText: "", lastAlertAt: 0, lastFailuresHash: "", consecutiveFailures: {} };
  }
}

async function saveState(state: HeartbeatState): Promise<void> {
  await mkdir(MUAVIN_DIR, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function checkRelayDaemon(): Promise<string | null> {
  const proc = Bun.spawn(["launchctl", "list"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  const relayLine = output.split("\n").find(l => l.includes("ai.muavin.relay"));
  if (!relayLine) return "Relay daemon not running";
  const parts = relayLine.trim().split(/\s+/);
  if (parts[0] === "-" && parts[1] !== "0") {
    return `Relay daemon not running (exit code: ${parts[1]})`;
  }
  return null;
}

async function checkRelayLock(): Promise<string | null> {
  const lockPath = join(MUAVIN_DIR, "relay.lock");
  try {
    const pid = parseInt(await readFile(lockPath, "utf-8"));
    if (isPidAlive(pid)) {
      return null;
    }
    return `Relay lock stale (PID ${pid} dead but lock exists)`;
  } catch {
    return null;
  }
}

async function checkJobPlists(): Promise<string | null> {
  const jobsPath = join(MUAVIN_DIR, "jobs.json");
  try {
    const allJobs = JSON.parse(await readFile(jobsPath, "utf-8"));
    const enabledJobs = allJobs.filter((j: any) => j.enabled);
    if (enabledJobs.length === 0) return null;

    const proc = Bun.spawn(["launchctl", "list"], { stdout: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const missing: string[] = [];
    for (const job of enabledJobs) {
      if (!output.includes(`ai.muavin.job.${job.id}`)) {
        missing.push(job.id);
      }
    }
    if (missing.length > 0) {
      return `Missing job plists: ${missing.join(", ")}`;
    }
    return null;
  } catch {
    return null;
  }
}

async function checkSupabase(): Promise<string | null> {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!,
    );
    const { error } = await supabase.from("user_blocks").select("id").limit(1);
    if (error) return `Supabase error: ${error.message}`;
    return null;
  } catch (e) {
    return `Supabase unreachable: ${formatError(e)}`;
  }
}

async function checkR2(): Promise<string | null> {
  const required = ["R2_BUCKET", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    return `R2 env missing: ${missing.join(", ")}`;
  }

  if (!Bun.which("aws")) {
    return "aws CLI not found (required for R2 uploads)";
  }

  try {
    const proc = Bun.spawn(
      ["aws", "s3", "ls", `s3://${process.env.R2_BUCKET}`, "--endpoint-url", process.env.R2_ENDPOINT_URL!, "--no-paginate"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID!,
          AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY!,
          AWS_DEFAULT_REGION: process.env.R2_REGION ?? "auto",
        },
      },
    );
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode !== 0) {
      return `R2 check failed: ${stderr.trim() || `aws exit ${proc.exitCode}`}`;
    }
    return null;
  } catch (e) {
    return `R2 unreachable: ${formatError(e)}`;
  }
}

async function checkOpenAI(): Promise<string | null> {
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: "heartbeat", dimensions: EMBEDDING_DIMS }),
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
    return null;
  } catch (e) {
    return `OpenAI unreachable: ${formatError(e)}`;
  }
}

async function checkTelegram(): Promise<string | null> {
  try {
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
    await bot.api.getMe();
    return null;
  } catch (e) {
    return `Telegram API error: ${formatError(e)}`;
  }
}

async function checkErrorLogs(lastRun: number): Promise<string | null> {
  const logFiles = [
    join(homedir(), "Library/Logs/muavin-relay.error.log"),
    join(homedir(), "Library/Logs/muavin-jobs.error.log"),
  ];

  // Read relay start timestamp (if exists)
  let relayStartTime = 0;
  try {
    const startFile = join(MUAVIN_DIR, "relay-started-at");
    const startStr = await readFile(startFile, "utf-8");
    relayStartTime = parseInt(startStr.trim(), 10);
  } catch {
    // If file doesn't exist, fall back to lastRun
    relayStartTime = lastRun;
  }

  const recentErrors: string[] = [];
  for (const logFile of logFiles) {
    try {
      const s = await stat(logFile);
      // Use relayStartTime instead of lastRun for filtering
      if (s.mtimeMs > relayStartTime && s.size > 0) {
        const content = await readFile(logFile, "utf-8");
        const lines = content.split("\n").filter(l => l.trim());
        const last = lines.slice(-5);
        if (last.length > 0) {
          const name = logFile.split("/").pop();
          recentErrors.push(`${name}:\n${last.join("\n")}`);
        }
      }
    } catch {
      continue;
    }
  }
  if (recentErrors.length > 0) {
    return `Recent errors in logs:\n  ${recentErrors.join("\n  ")}`;
  }
  return null;
}

async function checkStuckAgents(): Promise<string | null> {
  try {
    const running = await listAgents({ status: "running" });
    const stuck = running.filter(a => {
      if (!a.startedAt) return false;
      return Date.now() - new Date(a.startedAt).getTime() > 2 * 60 * 60_000; // 2h
    });
    if (stuck.length > 0) {
      // Recover stuck agents: mark as failed
      for (const agent of stuck) {
        // Guard against race: skip if already completed or failed
        if (agent.status === "completed" || agent.status === "failed") {
          continue;
        }
        await updateAgent(agent.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: "Stuck agent recovered by heartbeat (>2h)",
        }, agent._filename);
      }
      return `Recovered ${stuck.length} stuck agent(s): ${stuck.map(a => a.task).join(", ")}`;
    }
    return null;
  } catch {
    return null; // agents dir may not exist yet
  }
}

async function tryRestartDaemon(label: string, state: HeartbeatState): Promise<string> {
  const { existsSync } = await import("fs");
  const { STOPPED_MARKER, loadConfig, reloadService, getUid } = await import("./utils");

  if (existsSync(STOPPED_MARKER)) return `${label}: skipped restart (intentional stop)`;

  const config = await loadConfig();
  if (config.startOnLogin === false) return `${label}: skipped restart (startOnLogin disabled)`;

  const count = state.consecutiveFailures[label] ?? 0;
  if (count >= 3) return `${label}: crash loop detected (${count} consecutive failures, giving up)`;

  const uid = await getUid();
  const plistPath = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
  const result = await reloadService(uid, label, plistPath);

  if (!result.ok) {
    state.consecutiveFailures[label] = count + 1;
    return `${label}: restart failed (attempt ${count + 1}/3, exit ${result.exitCode})`;
  }

  await Bun.sleep(2000);

  const verifyProc = Bun.spawn(["launchctl", "list", label], { stdout: "pipe", stderr: "pipe" });
  await verifyProc.exited;

  if (verifyProc.exitCode === 0) {
    state.consecutiveFailures[label] = 0;
    return `${label}: restarted successfully`;
  }

  state.consecutiveFailures[label] = count + 1;
  return `${label}: restart verification failed (attempt ${count + 1}/3)`;
}

async function main() {
  const state = await loadState();

  const checks = await Promise.allSettled([
    checkRelayDaemon(),
    checkRelayLock(),
    checkJobPlists(),
    checkSupabase(),
    checkR2(),
    checkOpenAI(),
    checkTelegram(),
    checkErrorLogs(state.lastRun),
    checkStuckAgents(),
  ]);

  const failures: string[] = [];
  for (const check of checks) {
    if (check.status === "fulfilled" && check.value) {
      failures.push(check.value);
    } else if (check.status === "rejected") {
      failures.push(`Check crashed: ${check.reason}`);
    }
  }

  // Auto-restart crashed daemons
  for (let i = 0; i < failures.length; i++) {
    if (failures[i].includes("Relay daemon not running") || failures[i].includes("Relay lock stale")) {
      const outcome = await tryRestartDaemon("ai.muavin.relay", state);
      console.log(outcome);
      failures[i] = outcome;
    } else if (failures[i].includes("Missing job plists")) {
      try {
        const { syncJobPlists } = await import("./jobs");
        await syncJobPlists();
        failures[i] = "Job plists re-synced";
        console.log("Job plists re-synced");
      } catch (e) {
        failures[i] = `Job plist sync failed: ${formatError(e)}`;
      }
    }
  }

  if (failures.length === 0) {
    console.log("Heartbeat OK");
  } else {
    for (const f of failures) {
      console.error(`FAIL: ${f}`);
    }

    // AI triage — let Claude decide if this warrants an alert
    const promptsDir = join(MUAVIN_DIR, "prompts");
    const systemCwd = join(MUAVIN_DIR, "system");
    const triagePrompt = readFileSync(join(promptsDir, "heartbeat-triage.md"), "utf-8")
      .replace("{{HEALTH_RESULTS}}", failures.join("\n"));

    try {
      const result = await runLLM({
        task: "heartbeat_triage",
        prompt: triagePrompt,
        ephemeral: true,
        maxTurns: 1,
        cwd: systemCwd,
        timeoutMs: 120000,
      });

      if (isSkipResponse(result.text)) {
        console.log("AI triage: SKIP (not worth alerting)");
      } else {
        const failuresHash = [...failures].sort().join("|");
        const isDuplicate = failuresHash === state.lastFailuresHash &&
          (Date.now() - state.lastAlertAt) < 2 * 60 * 60_000;

        if (!isDuplicate) {
          const config = await loadConfig();
          const relayDown = failures.some(f => f.includes("Relay daemon not running") || f.includes("Relay lock stale"));

          if (relayDown) {
            // Relay is down — send directly via Telegram
            await sendTelegram(config.owner, result.text);
            console.log("Alert sent directly (relay is down)");
          } else {
            // Relay is up — write to outbox for voice processing
            await writeOutbox({
              source: "heartbeat",
              task: "Health alert",
              result: result.text,
              chatId: config.owner,
              createdAt: new Date().toISOString(),
            });
            console.log("Alert written to outbox");
          }
          state.lastAlertText = result.text;
          state.lastAlertAt = Date.now();
          state.lastFailuresHash = failuresHash;
        } else {
          console.log("Alert suppressed (duplicate within 2h)");
        }
      }
    } catch (e) {
      // Fallback to direct alert if Claude fails
      console.error("AI triage failed, sending raw alert:", e);
      const alertText = `Muavin Heartbeat Alert\n\n${failures.map(f => `- ${f}`).join("\n")}`;
      const config = await loadConfig();
      // Always send directly on triage failure (can't trust outbox if things are broken)
      await sendTelegram(config.owner, alertText);
    }
  }

  state.lastRun = Date.now();
  await saveState(state);
}

main().catch((e) => {
  console.error("Heartbeat fatal error:", e);
  process.exit(1);
});
