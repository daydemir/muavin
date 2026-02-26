# Agents

Background workers that run in parallel inside the relay process. Results flow through the outbox — the voice decides what to deliver.

## When to Use

- Research tasks requiring web search + analysis
- Multi-step investigations
- Any task you estimate will take >2 minutes of Claude time
- User explicitly asks for something to run in the background

## Creating an Agent

Use the CLI command:

```bash
bun muavin agent create --task "Short description" --prompt "Full detailed prompt" --chat-id <numeric chat ID>
```

The `chatId` is injected automatically by relay into every prompt. Extract it from the prompt header.

## Lifecycle

1. Agent file created with `"status": "pending"` in `~/.muavin/agents/`
2. Relay picks it up, sets `"status": "running"`, spawns Claude in background
3. Claude executes the prompt (with worker context — no personality, limited conversation context)
4. On completion: `"status": "completed"`, raw result written to `~/.muavin/outbox/`
5. Voice reads outbox, formats and delivers result to user (or skips if not worth it)
6. Old agents cleaned up after 7 days

## Sub-Agent Prompts

Give sub-agents everything they need in the prompt. They don't have your conversation history or personality. Be specific about:
- What to research/do
- What format to return results in
- Any constraints or priorities

## Data Guardrails (Must Follow)

- Do not write AI interpretations into `user_blocks`.
- Do not delete `user_blocks`.
- Write derived analysis, hypotheses, and extracted structure into `mua_blocks`.
- Treat `mua_blocks` as disposable and regenerable outputs.

## Checking on Agents

- Active agent summaries are automatically injected into voice context
- Read files from `~/.muavin/agents/` to see status
- Run `bun muavin status` to see overview
