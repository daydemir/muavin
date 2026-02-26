import { buildContext } from "./agents";
import { runLLM, type LlmProvider, type LlmResponse } from "./llm";

export interface RunBackgroundPromptInput {
  task: "agent_run" | "job_prompt";
  query: string;
  prompt: string;
  chatId: number;
  includeContext?: boolean;
  fullContext?: boolean;
  recentCount?: number;
  timeoutMs?: number;
  maxTurns?: number;
  model?: string;
  provider?: LlmProvider;
  cwd?: string;
}

export async function runBackgroundPrompt(input: RunBackgroundPromptInput): Promise<LlmResponse> {
  const includeContext = input.includeContext ?? true;
  const contextPrompt = includeContext
    ? await buildContext({
        query: input.query,
        chatId: input.chatId,
        recentCount: input.recentCount,
        full: input.fullContext,
      })
    : "";

  return runLLM({
    task: input.task,
    prompt: input.prompt,
    contextPrompt,
    ephemeral: true,
    timeoutMs: input.timeoutMs,
    maxTurns: input.maxTurns,
    model: input.model,
    provider: input.provider,
    cwd: input.cwd,
  });
}
