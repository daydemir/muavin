# Muavin — Developer Guide

Personal AI assistant that communicates via Telegram. Runs headlessly on macOS.

## Architecture
- 3 launchd daemons: relay (Telegram bot), cron (wakes every 15min, evaluates job schedules), heartbeat (30min health checks)
- Claude CLI spawned as subprocess via `src/claude.ts` with configurable cwd
- Memory: Supabase pgvector (messages + extracted facts)
- Background agents: JSON files in `~/.muavin/agents/`, processed by `src/agent-runner.ts`

## Key Files
- `src/relay.ts` — Telegram bot (Grammy)
- `src/cron.ts` — Scheduled job runner (reads jobs.json, wakes every 15min)
- `src/heartbeat.ts` — Health monitoring with AI-triaged alerts
- `src/claude.ts` — Claude CLI spawner
- `src/memory.ts` — Supabase vector search + memory extraction + generation
- `src/agents.ts` — Agent CRUD, context builder (`buildContext()`), jobs/agent summaries
- `src/agent-runner.ts` — Background agent executor
- `src/cli.ts` — Setup, deploy, status, config, agent CLI
- `src/utils.ts` — Shared utilities (lock, JSON I/O, config, timestamps)
- `src/telegram.ts` — Telegram send + pending alert queue

## Runtime Layout
- `~/.muavin/` — Config, state, sessions (interactive Claude sessions run here → has CLAUDE.md)
- `~/.muavin/muavin.md` — Lean identity file (injected via --append-system-prompt)
- `~/.muavin/docs/` — Reference docs (behavior.md, jobs.md, agents.md, skills.md)
- `~/.muavin/jobs.json` — ALL jobs (system + user, unified)
- `~/.muavin/prompts/` — Prompt templates read by memory.ts, heartbeat.ts, agent-runner.ts
- `~/.muavin/skills/` — Skill files (created by Muavin at runtime)
- `~/.muavin/agents/` — Agent JSON files
- `templates/` — Source templates for setup (CLAUDE.md, muavin.md, docs/)

## Running
- `bun muavin setup` — Interactive setup wizard
- `bun muavin start` — Deploy launchd daemons
- `bun muavin status` — Dashboard (daemons, sessions, cron, heartbeat, jobs, agents)
- `bun muavin stop` — Stop all daemons
- `bun muavin test` — Smoke tests
