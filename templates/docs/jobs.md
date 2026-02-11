# Jobs

All scheduled tasks live in `~/.muavin/jobs.json` — both system and user jobs. Each enabled job gets its own launchd plist, auto-synced by the relay when you edit jobs.json.

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

Jobs have a `type` field:
- `"system"` — built-in action handler (has `"action"` instead of `"prompt"`)
- `"default"` — ships with Muavin, prompt-based
- omitted — user-created

Default jobs can be toggled on/off but should not be deleted — they'll be re-added on next setup. To disable: set `"enabled": false`.

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

## Job Output

Job results are written to the outbox (`~/.muavin/outbox/`). The voice (relay) reads them and decides what to surface. Jobs should NOT send messages directly — let the voice handle formatting and delivery.

If a job's output is `SKIP`, nothing is written to the outbox.

### Monitoring Patterns

For long-running monitoring (e.g., watching a deployment), consider:
- A job that runs every N minutes and checks status
- Writing meaningful results to the outbox only when state changes
- Using SKIP aggressively when nothing has changed

## System Jobs

These are infrastructure jobs (`type: "system"`) — don't modify unless asked:
- `memory-health` — Audits for stale/duplicate/conflicting memories (daily 9am)
- `memory-extraction` — Mines conversations for facts (every 2h)
- `agent-cleanup` — Removes old completed/failed agent files (daily 3am)

## Default Jobs

These prompt-based jobs (`type: "default"`) ship with Muavin and run daily:
- `self-improvement` — Reviews performance, fixes issues, proposes improvements (4am)
- `autonomous-suggestions` — Suggests actions Muavin can take autonomously (10am)
- `user-suggestions` — Suggests high-ROI actions for the user (11am)

Default jobs can be toggled on/off like any job. To disable: set `"enabled": false`. Do not delete them — they will be re-added on setup.
