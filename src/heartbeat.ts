import { validateEnv } from "./env";
validateEnv();

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { Bot } from "grammy";
import { readFile, writeFile, stat, mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { sendTelegram } from "./telegram";
import { listAgents, updateAgent } from "./agents";
import { callClaude } from "./claude";
import { writeOutbox } from "./utils";

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
    join(process.env.HOME ?? "~", "Library/Logs/muavin-jobs.error.log"),
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
      // Recover stuck agents: mark as failed
      for (const agent of stuck) {
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

async function main() {
  const state = await loadState();

  const checks = await Promise.allSettled([
    checkRelayDaemon(),
    checkRelayLock(),
    checkJobPlists(),
    checkSupabase(),
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
        timeoutMs: 120000,
      });

      if (result.text.trim() === "SKIP") {
        console.log("AI triage: SKIP (not worth alerting)");
      } else {
        const isDuplicate = result.text === state.lastAlertText &&
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
