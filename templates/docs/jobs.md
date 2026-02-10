# Jobs

All scheduled tasks live in `~/.muavin/jobs.json` — both system and user jobs.

## Schema

```json
{
  "id": "j_<timestamp>",
  "name": "short description",
  "schedule": "cron expression",
  "prompt": "Full prompt for Claude. Must be self-contained. Include SKIP instruction.",
  "enabled": true
}
```

System jobs also have `"system": true` and `"action"` (built-in handler) instead of `"prompt"`.

## Managing Jobs

- **Create**: Append to the array. Use `id: "j_" + Date.now()`. Always include `"enabled": true`.
- **Pause**: Set `"enabled": false`. The job stays in the file but won't run.
- **Resume**: Set `"enabled": true`.
- **Delete**: Remove the entry from the array.
- **Edit**: Modify `schedule`, `prompt`, or `name` in place.

## Cron Expression Reference

- `0 9 * * *` — daily at 9am
- `0 */2 * * *` — every 2 hours
- `0 9 * * 1-5` — weekdays at 9am
- `*/30 * * * *` — every 30 minutes
- `0 9,18 * * *` — 9am and 6pm

## Writing Good Job Prompts

- Make prompts self-contained (don't assume context from other jobs)
- Always include: "If nothing notable, respond with exactly: SKIP"
- Be specific about what to check, where to look, and what format to use
- Jobs run with full tool access (web search, filesystem, APIs)

## System Jobs

These are infrastructure jobs — don't modify unless asked:
- `memory-health` — Audits for stale/duplicate/conflicting memories (daily 9am)
- `memory-extraction` — Mines conversations for facts (every 2h)
- `agent-cleanup` — Removes old completed/failed agent files (daily 3am)
