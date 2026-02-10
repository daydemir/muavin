import { spawn } from "bun";

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
}): Promise<ClaudeResult> {
  const args = ["claude", "-p", prompt, "--output-format", "json", "--dangerously-skip-permissions"];

  if (opts?.resume) args.push("--resume", opts.resume);
  if (opts?.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts?.noSessionPersistence) args.push("--no-session-persistence");
  if (opts?.maxTurns) args.push("--max-turns", String(opts.maxTurns));

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Claude exited ${exitCode}: ${stderr}`);
  }

  const parsed = JSON.parse(stdout);
  return {
    text: parsed.result ?? stdout,
    sessionId: parsed.session_id ?? "",
    costUsd: parsed.total_cost_usd ?? 0,
    durationMs: parsed.duration_ms ?? 0,
  };
}

// Test block — run with: bun run src/claude.ts
if (import.meta.main) {
  const result = await callClaude("Say hello in one sentence.");
  console.log("Result:", result);
}
