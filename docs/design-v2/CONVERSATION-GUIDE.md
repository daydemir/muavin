# Muavin v2: Design Spec Conversation Guide

This is the guide being used to structure the design conversation. Topics are worked through one at a time.

## What We Know Already

### Muavin Today
- Bun/TypeScript relay: Telegram <-> Claude Code subprocess
- Supabase (pgvector) for messages + memory tables
- Agent system (background Claude tasks), outbox (filtered delivery), scheduled jobs
- Source: `/Users/deniz/Build/muavin/`
- Runtime: `~/.muavin/` (config, agents, outbox, jobs, prompts, sessions)

### Decisions Made
- Muavin absorbs mix-assistant scope (thesis/startup thinking partner + ops)
- CRM: custom, minimal, Supabase-backed
- Notes: Currently Logseq, considering Obsidian or custom
- Email: Both iCloud Mail and Gmail
- Interface: Web dashboard + Telegram
- Drafts only, never auto-send
- AI never edits human-written text
- Single system, no personal/professional split
- Private by default; publish gate is the critical boundary

### Related Systems
- **mix-assistant**: 100+ research files, thesis proposals, startup pitch decks. To be absorbed.
- **interface-web**: Hugo static site (denizaydemir.com). Logseq -> Hugo -> Render.
- **Codex**: Picks up GH issues hourly for coding. Independent.
- **thesis-sdm**: Completed MIT thesis. Past work.
- **project_echo** (armanaydemir): Brother's logs-first personal logging system. Reference for ideas.

## Design Topics

### 0. Unified Ingestion & Memory [DISCUSSED]
Status: Core architecture agreed. See SPEC-DRAFT.md and CONVERSATION-LOG.md.

### 1. CRM & Contacts [TODO]
- How are people represented in notes today?
- What does "keeping a connection alive" look like?
- Schema: name + notes + activity log? Or richer?
- Auto-detect contacts from email/conversations?
- Build CRM independent of note app choice?

### 2. Reminders -> CRM Pipeline [TODO]
- Which Reminders list(s) to watch?
- What kinds of actions?
- How to parse intent from terse reminder text?
- Polling cadence?

### 3. Email Watching [TODO]
- Watch both iCloud + Gmail?
- Access method: Gmail API, IMAP, Apple Mail JXA?
- Scope: all incoming? Only CRM contacts?
- What to extract?
- Draft workflow?

### 4. Writing Support [PARTIALLY DISCUSSED]
- First use case: thesis/startup thinking
- Chat-based invocation on current writing context
- Need to unify thesis-sdm, life/logseq, mix-assistant content
- More details TBD

### 5. Notes -> Website Pipeline [TODO]
- Is Logseq -> interface -> interface-web still active?
- If moving to new note system, rebuild publishing?
- Muavin's role: suggest publish-ready content? Compile? Stay out?

### 6. Dashboard [TODO]
- What to show at a glance?
- Tech stack?
- Auth model?
- Muavin feature or separate deployment?

### 7. Codex / Coding Integration [TODO]
- Should muavin create GH issues for Codex?
- Monitor/summarize Codex output?
- Or keep fully separate?

### Cross-Cutting Topics
- Privacy & publish gate (weave into relevant topics)
- Muavin annotation model (partially discussed — life/.muavin/ pattern)
- Prioritization engine
- Storage / backup strategy
