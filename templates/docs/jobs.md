# Jobs

All scheduled tasks live in `~/.muavin/jobs.json`. Each enabled job gets its own launchd plist, auto-synced by the relay when you edit jobs.json.

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
- `"system"` — built-in action handler (uses `"action"`)
- `"default"` — ships with Muavin, prompt-based
- omitted — user-created

## System Jobs

Built-in system jobs in the block-based alpha:
- `state-processor` — every 5 minutes, processes pending user blocks/artifacts via Claude, updates MUA blocks/entities/links
- `files-ingest` — scans `filesInboxDir`, uploads to R2, extracts text/transcripts, and queues artifacts for processor analysis
- `agent-cleanup` — removes old completed/failed agent files and old upload temp files
- `clarification-digest` — sends pending clarification questions for low-confidence entity resolution

## Job Output

Jobs write results to the outbox (`~/.muavin/outbox/`). Relay decides what to deliver to Telegram.

If a job outputs `SKIP`, nothing is written to outbox.
