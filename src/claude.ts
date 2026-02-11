import { spawn } from "bun";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const ALLOWED_MODELS = ["sonnet", "opus", "haiku"];

export const activeChildPids = new Set<number>();

function loadModelFromConfig(): string | null {
  try {
    const raw = readFileSync(join(homedir(), ".muavin", "config.json"), "utf-8");
    const config = JSON.parse(raw);
    if (typeof config.model === "string" && ALLOWED_MODELS.includes(config.model)) {
      return config.model;
    }
    if (config.model != null) {
      console.warn(`[claude] invalid model "${config.model}" in config, ignoring (allowed: ${ALLOWED_MODELS.join(", ")})`);
    }
  } catch {}
  return null;
}

const configModel = loadModelFromConfig();

export interface ClaudeResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
}

export async function callClaude(prompt: string, opts?: {
  resume?: string;
  appendSystemPrompt?: string;
  noSessionPersistence?: boolean;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
  disallowedTools?: string[];
  model?: string;
}): Promise<ClaudeResult> {
  const args = ["claude", "-p", "--output-format", "json", "--dangerously-skip-permissions"];

  const effectiveModel = (opts?.model && ALLOWED_MODELS.includes(opts.model))
    ? opts.model
    : configModel;
  if (effectiveModel) args.push("--model", effectiveModel);

  if (opts?.resume) args.push("--resume", opts.resume);
  if (opts?.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts?.noSessionPersistence) args.push("--no-session-persistence");
  if (opts?.maxTurns) args.push("--max-turns", String(opts.maxTurns));
  if (opts?.disallowedTools?.length) args.push("--disallowed-tools", ...opts.disallowedTools);

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env },
    cwd: opts?.cwd ?? join(homedir(), ".muavin"),
  });

  if (proc.pid) activeChildPids.add(proc.pid);

  proc.stdin.write(prompt);
  proc.stdin.end();

  const processPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (proc.pid) activeChildPids.delete(proc.pid);

    if (exitCode !== 0) {
      throw new Error(`Claude exited ${exitCode}: ${stderr}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      console.error("JSON parse failed:", e);
      throw e;
    }

    const result = {
      text: parsed.result ?? stdout,
      sessionId: parsed.session_id ?? "",
      costUsd: parsed.total_cost_usd ?? 0,
      durationMs: parsed.duration_ms ?? 0,
    };

    return result;
  })();

  if (opts?.timeoutMs) {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (proc.pid && activeChildPids.has(proc.pid)) {
            proc.kill("SIGKILL");
          }
        }, 5000);
        const hours = Math.floor(opts.timeoutMs! / 3600000);
        const minutes = Math.floor((opts.timeoutMs! % 3600000) / 60000);
        const parts = [];
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        reject(new Error(`Claude timed out after ${parts.join(" ")}`));
      }, opts.timeoutMs);
    });

    return Promise.race([processPromise, timeoutPromise]);
  }

  return processPromise;
}

export async function killAllChildren(): Promise<void> {
  const pids = Array.from(activeChildPids);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
  for (const pid of pids) {
    if (activeChildPids.has(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  activeChildPids.clear();
}

// Test block — run with: bun run src/claude.ts
if (import.meta.main) {
  const result = await callClaude("Say hello in one sentence.");
  console.log("Result:", result);
}
