<pre>
  _ __ ___  _   _  __ _ __  _(_)_ __
 | '_ ` _ \| | | |/ _` \ \ / / | '_ \
 | | | | | | |_| | (_| |\ V /| | | | |
 |_| |_| |_|\__,_|\__,_| \_/ |_|_| |_|
</pre>


A personal AI assistant that runs 24/7 on your Mac and talks to you via Telegram.

## Features

- **Claude Code brain** — spawns the Claude CLI for every request, with full tool access (filesystem, shell, web search, MCP servers)
- **Persistent memory** — Supabase pgvector stores conversations and auto-extracted facts; relevant context is injected into every conversation
- **Telegram interface** — text, photos, documents, group mentions; chunked responses with Markdown
- **Cron system** — configurable scheduled jobs (custom prompts or built-in actions) via `config.json`
- **Health monitoring** — heartbeat daemon checks relay, cron, Supabase, OpenAI, Telegram; alerts via Telegram with 2h dedup

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/thisisdeniz/muavin/main/install.sh | bash
muavin setup
```

## Prerequisites

- macOS (Apple Silicon or Intel)
- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`)
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- [Supabase](https://supabase.com) project (free tier works)
- [OpenAI API key](https://platform.openai.com/api-keys) (for embeddings)

## Manual Installation

```bash
git clone https://github.com/thisisdeniz/muavin.git ~/.muavin/src
cd ~/.muavin/src
bun install
bun muavin setup
```

## Usage

```bash
bun muavin setup     # Interactive setup wizard
bun muavin start     # Deploy launchd daemons
bun muavin stop      # Stop all daemons
bun muavin status    # Check daemon and session status
bun muavin config    # Edit configuration (TUI)
bun muavin test      # Run smoke tests
```

## How It Works

Muavin runs as three macOS launchd daemons:

- **Relay** — Grammy Telegram bot (KeepAlive). Receives messages, vector-searches Supabase for context, spawns `claude` CLI, returns response.
- **Cron** — Runs every 15 minutes. Executes scheduled jobs from `config.json`: memory extraction (every 2h), health audit (daily), and custom prompts.
- **Heartbeat** — Runs every 30 minutes. Checks relay, cron, Supabase, OpenAI, Telegram. Sends alerts with 2h dedup.

**Memory**: Conversations are stored in Supabase with OpenAI embeddings. A cron job extracts facts every 2h and deduplicates against existing memories. Relevant context is vector-searched and injected into every conversation.

## Configuration

`~/.muavin/config.json`:

| Key | Description | Default |
|-----|-------------|---------|
| `owner` | Your Telegram user ID | — |
| `allowUsers` | Allowed Telegram user IDs | `[]` |
| `allowGroups` | Allowed Telegram group IDs | `[]` |
| `model` | Claude model (`sonnet`, `opus`, `haiku`) | `sonnet` |
| `claudeTimeoutMs` | Max time per Claude call (ms) | `43200000` (12h) |
| `startOnLogin` | Auto-start daemons on macOS login | `true` |
| `cron` | Array of scheduled jobs | (see `config.example.json`) |

`~/.muavin/.env`:

| Key | Required | Description |
|-----|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | From @BotFather |
| `SUPABASE_URL` | Yes | Project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Service role key |
| `OPENAI_API_KEY` | Yes | For embeddings |
| `ANTHROPIC_API_KEY` | No | For Claude Code CLI (if not already set) |
| `XAI_API_KEY` | No | Grok access |
| `GEMINI_API_KEY` | No | Gemini access |
| `OPENROUTER_API_KEY` | No | OpenRouter access |
| `BRAVE_API_KEY` | No | Brave Search |

## Credits & Inspiration

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic
- [Grammy](https://grammy.dev) — Telegram bot framework
- [Supabase](https://supabase.com) — pgvector for memory
- [Croner](https://github.com/hexagon/croner) — cron scheduling
- Inspired by [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) and [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)

## License

MIT
