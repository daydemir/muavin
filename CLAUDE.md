# Muavin — Developer Guide

Personal AI assistant that communicates via Telegram. Runs headlessly on macOS.

## Architecture
- 2 core daemons (relay, heartbeat) + per-job launchd plists. Relay is the voice + agent runner. Results flow through the outbox.
- Claude CLI spawned as subprocess via `src/claude.ts` with configurable cwd
- Memory: Supabase pgvector (messages + extracted facts)
- Background agents: JSON files in `~/.muavin/agents/`, executed by relay in parallel

## Key Files
- `src/relay.ts` — Telegram bot (Grammy) + agent runner + outbox processor
- `src/run-job.ts` — Single-job executor (launchd entry point)
- `src/jobs.ts` — Job plist generation + sync
- `src/heartbeat.ts` — Health monitoring with AI-triaged alerts
- `src/claude.ts` — Claude CLI spawner
- `src/memory.ts` — Supabase vector search + memory extraction + generation
- `src/agents.ts` — Agent CRUD, context builder (`buildContext()`), jobs/agent summaries
- `src/cli.ts` — Setup, deploy, status, config, agent CLI
- `src/utils.ts` — Shared utilities (lock, JSON I/O, config, timestamps, outbox)
- `src/telegram.ts` — Telegram send (with Markdown fallback)

## Runtime Layout
- `~/.muavin/` — Config, state, sessions (interactive Claude sessions run here → has CLAUDE.md)
- `~/.muavin/muavin.md` — Lean identity file (injected via --append-system-prompt)
- `~/.muavin/docs/` — Reference docs (behavior.md, jobs.md, agents.md, skills.md)
- `~/.muavin/jobs.json` — ALL jobs (system + user, unified)
- `~/.muavin/prompts/` — Prompt templates read by memory.ts, heartbeat.ts
- `~/.muavin/skills/` — Skill files (created by Muavin at runtime)
- `~/.muavin/agents/` — Agent JSON files
- `~/.muavin/outbox/` — Pending results (agent completions, job output, heartbeat alerts)
- `templates/` — Source templates for setup (CLAUDE.md, muavin.md, docs/)

## Running
- `bun muavin setup` — Interactive setup wizard
- `bun muavin start` — Deploy launchd daemons
- `bun muavin status` — Dashboard (daemons, sessions, heartbeat, jobs, agents)
- `bun muavin stop` — Stop all daemons
- `bun muavin test` — Smoke tests
