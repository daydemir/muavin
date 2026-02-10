import { spawn } from "bun";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const ALLOWED_MODELS = ["sonnet", "opus", "haiku"];

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
}): Promise<ClaudeResult> {
  const startTime = Date.now();
  const timestamp = () => `[claude ${new Date().toISOString()}]`;

  console.log(`${timestamp()} callClaude invoked with prompt length: ${prompt.length} chars`);
  console.log(`${timestamp()} Options: resume=${opts?.resume?.slice(0, 8) ?? 'none'}, appendSystemPrompt=${opts?.appendSystemPrompt ? 'yes' : 'no'}, timeoutMs=${opts?.timeoutMs ?? 'none'}`);

  const args = ["claude", "-p", "--output-format", "json", "--dangerously-skip-permissions"];

  if (configModel) args.push("--model", configModel);

  if (opts?.resume) args.push("--resume", opts.resume);
  if (opts?.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts?.noSessionPersistence) args.push("--no-session-persistence");
  if (opts?.maxTurns) args.push("--max-turns", String(opts.maxTurns));

  console.log(`${timestamp()} Spawning Claude with args:`, args);

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env },
    cwd: opts?.cwd ?? join(homedir(), ".muavin"),
  });

  console.log(`${timestamp()} Process spawned, writing ${prompt.length} chars to stdin`);
  proc.stdin.write(prompt);
  console.log(`${timestamp()} stdin.write() completed, calling stdin.end()`);
  proc.stdin.end();
  console.log(`${timestamp()} stdin.end() completed, waiting for process output`);

  const processPromise = (async () => {
    console.log(`${timestamp()} Starting to read stdout and stderr`);
    const stdout = await new Response(proc.stdout).text();
    console.log(`${timestamp()} stdout received (${stdout.length} chars): ${stdout.slice(0, 500)}${stdout.length > 500 ? '...' : ''}`);

    const stderr = await new Response(proc.stderr).text();
    console.log(`${timestamp()} stderr received (${stderr.length} chars): ${stderr.slice(0, 500)}${stderr.length > 500 ? '...' : ''}`);

    const exitCode = await proc.exited;
    console.log(`${timestamp()} Process exited with code: ${exitCode}`);

    if (exitCode !== 0) {
      console.error(`${timestamp()} Non-zero exit code, throwing error`);
      throw new Error(`Claude exited ${exitCode}: ${stderr}`);
    }

    console.log(`${timestamp()} Attempting to parse JSON from stdout`);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
      console.log(`${timestamp()} JSON parse successful, keys: ${Object.keys(parsed).join(', ')}`);
    } catch (e) {
      console.error(`${timestamp()} JSON parse failed:`, e);
      throw e;
    }

    const result = {
      text: parsed.result ?? stdout,
      sessionId: parsed.session_id ?? "",
      costUsd: parsed.total_cost_usd ?? 0,
      durationMs: parsed.duration_ms ?? 0,
    };

    const elapsed = Date.now() - startTime;
    console.log(`${timestamp()} callClaude completed in ${elapsed}ms, returning text length: ${result.text.length} chars`);

    return result;
  })();

  if (opts?.timeoutMs) {
    console.log(`${timestamp()} Setting timeout for ${opts.timeoutMs}ms`);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        console.log(`${timestamp()} TIMEOUT TRIGGERED after ${opts.timeoutMs}ms, killing process`);
        proc.kill();
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

// Test block — run with: bun run src/claude.ts
if (import.meta.main) {
  const result = await callClaude("Say hello in one sentence.");
  console.log("Result:", result);
}
