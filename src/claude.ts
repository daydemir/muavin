import { spawn } from "bun";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const ALLOWED_MODELS = ["sonnet", "opus", "haiku"];
const KILL_GRACE_MS = 2000;
const OUTPUT_EXCERPT_LIMIT = 280;

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

function formatTimeout(timeoutMs: number): string {
  const totalSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export interface ClaudeResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  structuredOutput?: unknown;
}

export interface ClaudeCallOptions {
  resume?: string;
  appendSystemPrompt?: string;
  noSessionPersistence?: boolean;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
  disallowedTools?: string[];
  model?: string;
  jsonSchema?: object;
}

type ClaudeReadable = ReadableStream<Uint8Array<ArrayBufferLike>>;

export interface ClaudeSpawnedProcess {
  stdout: ClaudeReadable;
  stderr: ClaudeReadable;
  stdin: {
    write(chunk: string): void;
    end(): void;
  };
  exited: Promise<number>;
  pid?: number;
  kill(signal?: string): void;
}

interface ClaudeSpawnOptions {
  stdout: "pipe";
  stderr: "pipe";
  stdin: "pipe";
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export type ClaudeSpawn = (
  args: string[],
  opts: ClaudeSpawnOptions,
) => ClaudeSpawnedProcess;

export class ClaudeProcessError extends Error {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cwd: string;
  readonly args: string[];
  readonly timedOut: boolean;
  readonly model: string | null;

  constructor(input: {
    message: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    cwd: string;
    args: string[];
    timedOut: boolean;
    model: string | null;
  }) {
    super(input.message);
    this.name = "ClaudeProcessError";
    this.exitCode = input.exitCode;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
    this.cwd = input.cwd;
    this.args = input.args;
    this.timedOut = input.timedOut;
    this.model = input.model;
  }
}

function excerptOutput(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= OUTPUT_EXCERPT_LIMIT) return normalized;
  return `${normalized.slice(0, OUTPUT_EXCERPT_LIMIT)}...`;
}

function createClaudeProcessError(input: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cwd: string;
  args: string[];
  timedOut: boolean;
  timeoutMs?: number;
  model: string | null;
  parseError?: unknown;
}): ClaudeProcessError {
  const details: string[] = [`cwd=${input.cwd}`];
  if (input.model) details.push(`model=${input.model}`);
  const stdoutExcerpt = excerptOutput(input.stdout);
  const stderrExcerpt = excerptOutput(input.stderr);

  if (stderrExcerpt) details.push(`stderr=${stderrExcerpt}`);
  else if (stdoutExcerpt) details.push(`stdout=${stdoutExcerpt}`);

  let message: string;
  if (input.timedOut) {
    message = `Claude timed out after ${formatTimeout(input.timeoutMs ?? 0)}`;
  } else if (input.parseError) {
    const parseMsg = input.parseError instanceof Error ? input.parseError.message : String(input.parseError);
    message = `Claude returned invalid JSON: ${parseMsg}`;
  } else {
    message = `Claude exited ${input.exitCode ?? "unknown"}`;
  }

  return new ClaudeProcessError({
    message: `${message} (${details.join(", ")})`,
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    cwd: input.cwd,
    args: input.args,
    timedOut: input.timedOut,
    model: input.model,
  });
}

function buildClaudeArgs(opts?: ClaudeCallOptions): { args: string[]; effectiveModel: string | null } {
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
  if (opts?.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  return { args, effectiveModel };
}

function safeKill(proc: ClaudeSpawnedProcess, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    proc.kill(signal);
  } catch {}
}

const defaultClaudeSpawn: ClaudeSpawn = (args, opts) => {
  const proc = spawn(args, opts);
  return {
    stdout: proc.stdout as ClaudeReadable,
    stderr: proc.stderr as ClaudeReadable,
    stdin: proc.stdin as ClaudeSpawnedProcess["stdin"],
    exited: proc.exited,
    pid: proc.pid,
    kill: (signal?: string) => proc.kill(signal as any),
  };
};

export async function callClaudeWithSpawn(
  prompt: string,
  opts?: ClaudeCallOptions,
  spawnImpl: ClaudeSpawn = defaultClaudeSpawn,
): Promise<ClaudeResult> {
  const { args, effectiveModel } = buildClaudeArgs(opts);
  const cwd = opts?.cwd ?? join(homedir(), ".muavin");
  const proc = spawnImpl(args, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env },
    cwd,
  });

  if (proc.pid) activeChildPids.add(proc.pid);

  proc.stdin.write(prompt);
  proc.stdin.end();

  return await new Promise<ClaudeResult>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const finalize = () => {
      if (settled) return false;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (proc.pid) activeChildPids.delete(proc.pid);
      return true;
    };

    (async () => {
      const stdout = await new Response(proc.stdout as BodyInit).text();
      const stderr = await new Response(proc.stderr as BodyInit).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        throw createClaudeProcessError({
          exitCode,
          stdout,
          stderr,
          cwd,
          args,
          timedOut: false,
          model: effectiveModel,
        });
      }

      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch (parseError) {
        throw createClaudeProcessError({
          exitCode,
          stdout,
          stderr,
          cwd,
          args,
          timedOut: false,
          model: effectiveModel,
          parseError,
        });
      }

      return {
        text: parsed.result || "",
        sessionId: parsed.session_id ?? "",
        costUsd: parsed.total_cost_usd ?? 0,
        durationMs: parsed.duration_ms ?? 0,
        structuredOutput: parsed.structured_output,
      } satisfies ClaudeResult;
    })().then(
      (result) => {
        if (!finalize()) return;
        resolve(result);
      },
      (error) => {
        if (!finalize()) return;
        reject(error);
      },
    );

    if (!opts?.timeoutMs) return;

    timeoutHandle = setTimeout(() => {
      if (!finalize()) return;
      safeKill(proc, "SIGTERM");
      setTimeout(() => {
        if (proc.pid && activeChildPids.has(proc.pid)) {
          safeKill(proc, "SIGKILL");
          activeChildPids.delete(proc.pid);
        }
      }, KILL_GRACE_MS);
      reject(createClaudeProcessError({
        exitCode: null,
        stdout: "",
        stderr: "",
        cwd,
        args,
        timedOut: true,
        timeoutMs: opts.timeoutMs,
        model: effectiveModel,
      }));
    }, opts.timeoutMs);
  });
}

export async function callClaude(prompt: string, opts?: ClaudeCallOptions): Promise<ClaudeResult> {
  return await callClaudeWithSpawn(prompt, opts, defaultClaudeSpawn);
}

export async function waitForChildren(timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();
  while (activeChildPids.size > 0 && Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return activeChildPids.size === 0;
}

export async function killAllChildren(): Promise<void> {
  const pids = Array.from(activeChildPids);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS));
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
