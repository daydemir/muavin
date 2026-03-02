<div align="center">
<img src="assets/logo.png" alt="muavin" width="600">

A personal AI assistant with a block-first knowledge system.
</div>

> [!WARNING]
> Experimental software. Muavin can run shell commands, read/write files, and access external APIs.

## Alpha architecture (clean-slate)

Muavin now uses a single atomic block model:
- `user_blocks`: your canonical notes/messages/inputs
- `mua_blocks`: Muavin-generated interpretations, drafts, questions, and follow-ups
- `artifacts`: inbox objects (files, email, notes, reminders) with extracted text/transcripts
- `entities` + `links`: optional CRM graph over blocks/artifacts
- `clarification_queue`: low-confidence disambiguation workflow (Telegram + CLI)

No legacy `messages/memory` tables are used.

## Requirements

- macOS
- Bun
- Claude Code CLI
- Supabase (with `supabase-schema.sql` applied)
- Optional direct Postgres URL (`SUPABASE_DB_URL`) for automatic schema setup/migrations
- OpenAI API key (embeddings + transcription/vision extraction)
- Cloudflare R2 (required)
- System tools: `aws`, `pdftotext`, `ffmpeg`

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/daydemir/muavin/main/install.sh | bash
muavin setup
muavin start
```

## CLI

```bash
bun muavin write     # block writing UI
bun muavin crm       # CRM view derived from blocks/entities/links
bun muavin inbox     # list artifacts
bun muavin ingest    # run ingestion (files implemented)
bun muavin clarify   # clarification digest + answers
bun muavin status
bun muavin config
bun muavin test
```

## Required env

`~/.muavin/.env` must include:
- `TELEGRAM_BOT_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `OPENAI_API_KEY`
- `R2_BUCKET`
- `R2_ENDPOINT_URL`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Optional but recommended:
- `SUPABASE_DB_URL` (for automatic schema application and migration workflows)

## License

MIT
