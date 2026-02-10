# Muavin — Developer Guide

Personal AI assistant that communicates via Telegram. Runs headlessly on macOS.

## Architecture
- 3 launchd daemons: relay (Telegram bot), cron (15min scheduler), heartbeat (30min health checks)
- Claude CLI spawned as subprocess via `src/claude.ts` with configurable cwd
- Memory: Supabase pgvector (messages + extracted facts)
- Background agents: JSON files in `~/.muavin/agents/`, processed by `src/agent-runner.ts`

## Key Files
- `src/relay.ts` — Telegram bot (Grammy)
- `src/cron.ts` — Scheduled job runner (system jobs from config.json + user jobs from jobs.json)
- `src/heartbeat.ts` — Health monitoring with AI-triaged alerts
- `src/claude.ts` — Claude CLI spawner
- `src/memory.ts` — Supabase vector search + memory extraction
- `src/agents.ts` — Agent CRUD + session context builder
- `src/agent-runner.ts` — Background agent executor
- `src/cli.ts` — Setup, deploy, status, config CLI
- `src/telegram.ts` — Telegram send + pending alert queue

## Runtime Layout
- `~/.muavin/` — Config, state, sessions (interactive Claude sessions run here → has CLAUDE.md)
- `~/.muavin/system/` — Empty dir for utility sessions (no CLAUDE.md → clean JSON output)
- `~/.muavin/prompts/` — Prompt templates read by memory.ts, heartbeat.ts, agent-runner.ts
- `~/.muavin/jobs.json` — User-managed scheduled jobs
- `~/.muavin/skills/` — Skill files (created by Muavin at runtime)
- `~/.muavin/USER.md` — User context file
- `CLAUDE.example.md` — Template for `~/.muavin/CLAUDE.md` (copied on setup)

## Running
- `bun muavin setup` — Interactive setup wizard
- `bun muavin start` — Deploy launchd daemons
- `bun muavin status` — Dashboard (daemons, sessions, cron, heartbeat, jobs, agents)
- `bun muavin stop` — Stop all daemons
- `bun muavin test` — Smoke tests
