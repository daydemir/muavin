# Agents

For tasks that take >2 minutes (deep research, multi-step analysis, complex work), use background agents instead of blocking the conversation.

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

The command creates the agent file and starts the runner automatically.

## Checking on Agents

- Active agent summaries are automatically injected into your context
- Read files from `~/.muavin/agents/` to see status of all agents
- Run `bun muavin status` to see agent overview

## Lifecycle

1. Agent file created with `"status": "pending"`
2. Runner picks it up, sets `"status": "running"`
3. Claude executes the prompt
4. On completion: `"status": "completed"`, result delivered via Telegram
5. Old agents cleaned up after 7 days
