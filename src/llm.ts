import { callClaude } from "./claude";

export type LlmProvider = "claude-cli";

export type LlmTask =
  | "telegram_conversation"
  | "outbox_delivery"
  | "agent_run"
  | "job_prompt"
  | "block_processor"
  | "artifact_processor"
  | "heartbeat_triage";

export type LlmToolPolicy = "default" | "no_background_claude_shell";

export interface LlmRequest {
  task: LlmTask;
  prompt: string;
  contextPrompt?: string;
  sessionId?: string;
  ephemeral?: boolean;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
  model?: string;
  jsonSchema?: object;
  toolPolicy?: LlmToolPolicy;
  provider?: LlmProvider;
}

export interface LlmResponse {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  structuredOutput?: unknown;
  provider: LlmProvider;
}

interface LlmAdapter {
  readonly name: LlmProvider;
  run(req: LlmRequest): Promise<LlmResponse>;
}

const DEFAULT_EPHEMERAL_BY_TASK: Record<LlmTask, boolean> = {
  telegram_conversation: false,
  outbox_delivery: true,
  agent_run: true,
  job_prompt: true,
  block_processor: true,
  artifact_processor: true,
  heartbeat_triage: true,
};

const claudeAdapter: LlmAdapter = {
  name: "claude-cli",
  async run(req: LlmRequest): Promise<LlmResponse> {
    const disallowedTools = req.toolPolicy === "no_background_claude_shell"
      ? ["Bash(claude*)"]
      : undefined;

    const result = await callClaude(req.prompt, {
      resume: req.sessionId,
      appendSystemPrompt: req.contextPrompt,
      noSessionPersistence: req.ephemeral ?? DEFAULT_EPHEMERAL_BY_TASK[req.task],
      maxTurns: req.maxTurns,
      timeoutMs: req.timeoutMs,
      cwd: req.cwd,
      disallowedTools,
      model: req.model,
      jsonSchema: req.jsonSchema,
    });

    return {
      ...result,
      provider: "claude-cli",
    };
  },
};

const ADAPTERS: Record<LlmProvider, LlmAdapter> = {
  "claude-cli": claudeAdapter,
};

export async function runLLM(req: LlmRequest): Promise<LlmResponse> {
  const provider = req.provider ?? "claude-cli";
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new Error(`LLM provider not configured: ${provider}`);
  }
  return adapter.run(req);
}
