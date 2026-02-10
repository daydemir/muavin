import { validateEnv } from "./env";
validateEnv();

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { Bot } from "grammy";
import { readFile, writeFile, stat, mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { sendTelegram, checkPendingAlerts } from "./telegram";
import { listAgents } from "./agents";
import { callClaude } from "./claude";

const MUAVIN_DIR = join(process.env.HOME ?? "~", ".muavin");
const STATE_PATH = join(MUAVIN_DIR, "heartbeat-state.json");
const CONFIG_PATH = join(MUAVIN_DIR, "config.json");

interface HeartbeatState {
  lastRun: number;
  lastAlertText: string;
  lastAlertAt: number;
}

async function loadState(): Promise<HeartbeatState> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf-8"));
  } catch {
    return { lastRun: 0, lastAlertText: "", lastAlertAt: 0 };
  }
}

async function saveState(state: HeartbeatState): Promise<void> {
  await mkdir(MUAVIN_DIR, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadConfig(): Promise<{ owner: number }> {
  return JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
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
    try {
      process.kill(pid, 0);
      return null;
    } catch {
      return `Relay lock stale (PID ${pid} dead but lock exists)`;
    }
  } catch {
    return null;
  }
}

async function checkCronFreshness(): Promise<string | null> {
  const cronStatePath = join(MUAVIN_DIR, "cron-state.json");
  try {
    const s = await stat(cronStatePath);
    const ageMs = Date.now() - s.mtimeMs;
    const ageMin = Math.round(ageMs / 60_000);
    if (ageMs > 30 * 60_000) {
      return `Cron state stale (last modified ${ageMin}m ago)`;
    }
    return null;
  } catch {
    return "Cron state file not found";
  }
}

async function checkSupabase(): Promise<string | null> {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!,
    );
    const { error } = await supabase.from("messages").select("id").limit(1);
    if (error) return `Supabase error: ${error.message}`;
    return null;
  } catch (e) {
    return `Supabase unreachable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function checkOpenAI(): Promise<string | null> {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: "heartbeat",
    });
    return null;
  } catch (e) {
    return `OpenAI unreachable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function checkTelegram(): Promise<string | null> {
  try {
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
    await bot.api.getMe();
    return null;
  } catch (e) {
    return `Telegram API error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function checkErrorLogs(lastRun: number): Promise<string | null> {
  const logFiles = [
    join(process.env.HOME ?? "~", "Library/Logs/muavin-relay.error.log"),
    join(process.env.HOME ?? "~", "Library/Logs/muavin-cron.error.log"),
  ];
  const recentErrors: string[] = [];
  for (const logFile of logFiles) {
    try {
      const s = await stat(logFile);
      if (s.mtimeMs > lastRun && s.size > 0) {
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
      return `${stuck.length} stuck agent(s): ${stuck.map(a => a.task).join(", ")}`;
    }
    return null;
  } catch {
    return null; // agents dir may not exist yet
  }
}

async function main() {
  const state = await loadState();

  const checks = await Promise.allSettled([
    checkRelayDaemon(),
    checkRelayLock(),
    checkCronFreshness(),
    checkSupabase(),
    checkOpenAI(),
    checkTelegram(),
    checkErrorLogs(state.lastRun),
    checkPendingAlerts(),
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

  if (failures.length === 0) {
    console.log("Heartbeat OK");
  } else {
    for (const f of failures) {
      console.error(`FAIL: ${f}`);
    }

    // AI triage — let Claude decide if this warrants an alert
    const promptsDir = join(process.env.HOME ?? "~", ".muavin", "prompts");
    const systemCwd = join(process.env.HOME ?? "~", ".muavin", "system");
    const triagePrompt = readFileSync(join(promptsDir, "heartbeat-triage.md"), "utf-8")
      .replace("{{HEALTH_RESULTS}}", failures.join("\n"));

    try {
      const result = await callClaude(triagePrompt, {
        noSessionPersistence: true,
        maxTurns: 1,
        cwd: systemCwd,
      });

      if (result.text.trim() === "SKIP") {
        console.log("AI triage: SKIP (not worth alerting)");
      } else {
        const isDuplicate = result.text === state.lastAlertText &&
          (Date.now() - state.lastAlertAt) < 2 * 60 * 60_000;

        if (!isDuplicate) {
          const config = await loadConfig();
          const sent = await sendTelegram(config.owner, result.text);
          if (sent) {
            state.lastAlertText = result.text;
            state.lastAlertAt = Date.now();
            console.log("AI-triaged alert sent to Telegram");
          } else {
            console.error("Failed to send heartbeat alert (queued for retry)");
          }
        } else {
          console.log("Alert suppressed (duplicate within 2h)");
        }
      }
    } catch (e) {
      // Fallback to direct alert if Claude fails
      console.error("AI triage failed, sending raw alert:", e);
      const alertText = `Muavin Heartbeat Alert\n\n${failures.map(f => `- ${f}`).join("\n")}`;
      const config = await loadConfig();
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
