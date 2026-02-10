<div align="center">
<pre>
  _ __ ___  _   _  __ _ __  _(_)_ __
 | '_ ` _ \| | | |/ _` \ \ / / | '_ \
 | | | | | | |_| | (_| |\ V /| | | | |
 |_| |_| |_|\__,_|\__,_| \_/ |_|_| |_|
</pre>

A personal AI assistant that runs 24/7 on your Mac and talks to you via Telegram.

[![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Claude Code](https://img.shields.io/badge/Claude_Code-cc785c?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![Telegram](https://img.shields.io/badge/Telegram-2CA5E0?logo=telegram&logoColor=white)](https://telegram.org)

</div>

## ✨ Features

- **Claude Code brain** — spawns the Claude CLI for every request, with full tool access (filesystem, shell, web search, MCP servers)
- **Persistent memory** — Supabase pgvector stores conversations and auto-extracted facts; relevant context is injected into every conversation
- **Telegram interface** — text, photos, documents, group mentions; chunked responses with Markdown
- **Cron system** — configurable scheduled jobs (custom prompts or built-in actions) via `config.json`
- **Health monitoring** — heartbeat daemon checks relay, cron, Supabase, OpenAI, Telegram; alerts via Telegram with 2h dedup

## 🏗 Architecture

```mermaid
flowchart TD
    You((You)) <-->|messages\nphotos\ndocs| TG[Telegram]

    subgraph Daemons["macOS launchd daemons"]
        Relay["🔄 Relay\n(KeepAlive)"]
        Cron["⏰ Cron\n(every 15 min)"]
        Heartbeat["💓 Heartbeat\n(every 30 min)"]
    end

    TG <--> Relay
    TG <-- alerts --- Heartbeat
    TG <-- job results --- Cron

    Relay -->|spawns per message| Claude["🧠 Claude CLI"]
    Relay <-->|store messages\nvector search| Supa[("Supabase\npgvector")]

    Cron -->|extract facts\nmemory health| Supa
    Cron -->|scheduled prompts| Claude

    Claude --> MCP["MCP Servers\nGoogle Workspace · Apple Reminders\nApple Notes · Web · Files · Git"]

    Heartbeat -.->|monitors| Relay
    Heartbeat -.->|checks freshness| Cron
    Heartbeat -.->|test query| Supa
    Heartbeat -.->|test embed| OAI["OpenAI\n(embeddings)"]
    Heartbeat -.->|getMe| TG

    Supa <-.->|embed text| OAI
```

> Three launchd daemons: **Relay** receives Telegram messages and spawns Claude CLI with vector-searched memory context. **Cron** runs scheduled jobs — fact extraction, memory health checks, and custom prompts. **Heartbeat** monitors all services and sends AI-triaged alerts.

## 🚀 Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/daydemir/muavin/main/install.sh | bash
muavin setup
```

<details>
<summary><strong>Prerequisites</strong></summary>

- macOS (Apple Silicon or Intel)
- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`)
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- [Supabase](https://supabase.com) project (free tier works)
- [OpenAI API key](https://platform.openai.com/api-keys) (for embeddings)

</details>

<details>
<summary><strong>Manual Installation</strong></summary>

```bash
git clone https://github.com/daydemir/muavin.git ~/.muavin/src
cd ~/.muavin/src
bun install
bun muavin setup
```

</details>

## 💻 Usage

```bash
bun muavin setup     # Interactive setup wizard
bun muavin start     # Deploy launchd daemons
bun muavin stop      # Stop all daemons
bun muavin status    # Check daemon and session status
bun muavin config    # Edit configuration (TUI)
bun muavin test      # Run smoke tests
```

<details>
<summary><strong>⚙️ Configuration</strong></summary>

`~/.muavin/config.json`:

| Key | Description | Default |
|-----|-------------|---------|
| `owner` | Your Telegram user ID | — |
| `allowUsers` | Allowed Telegram user IDs | `[]` |
| `allowGroups` | Allowed Telegram group IDs | `[]` |
| `model` | Claude model (`sonnet`, `opus`, `haiku`) | `sonnet` |
| `claudeTimeoutMs` | Max time per Claude call (ms) | `43200000` |
| `agentMaxTurns` | Max turns for background agents | `25` |
| `agentTimeoutMs` | Timeout for background agents (ms) | `600000` |
| `recentMessageCount` | Recent messages fetched from Supabase for context | `10` |
| `startOnLogin` | Auto-start daemons on macOS login | `true` |

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

</details>

## 🙏 Credits

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic
- [Grammy](https://grammy.dev) — Telegram bot framework
- [Supabase](https://supabase.com) — pgvector for memory
- [Croner](https://github.com/hexagon/croner) — cron scheduling
- Inspired by [OpenClaw](https://github.com/openclaw/openclaw), [godagoo/claude-telegram-relay](https://github.com/godagoo/claude-telegram-relay), and [HKUDS/nanobot](https://github.com/HKUDS/nanobot)

## License

MIT
