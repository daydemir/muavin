# Muavin 1.0: Design Spec Conversation Guide

This is the guide being used to structure the design conversation. Topics are worked through one at a time.

## What We Know Already

### Muavin Today
- Bun/TypeScript relay: Telegram <-> Claude Code subprocess
- Supabase (pgvector) for messages + memory tables
- Agent system (background Claude tasks), outbox (filtered delivery), scheduled jobs
- Source: `/Users/deniz/Build/muavin/`
- Runtime: `~/.muavin/` (config, agents, outbox, jobs, prompts, sessions)

### Decisions Made
- Milestone naming: this is the Muavin 1.0 architecture track (not v2)
- Muavin absorbs mix-assistant scope (thesis/startup thinking partner + ops)
- CRM: custom, minimal, Supabase-backed
- Notes: Currently Logseq, considering Obsidian or custom
- Email: Both iCloud Mail and Gmail
- Interface: Web dashboard + Telegram
- Drafts only, never auto-send
- AI never edits human-written text
- Single system, no personal/professional split
- Private by default; publish gate is the critical boundary

### Current Implementation Baseline (Session 2 Audit)
- Muavin today is a robust Telegram relay + jobs/agents/outbox + Supabase memory system.
- Memory extraction is active but currently generic (`personal_fact`, `preference`, `goal`, `relationship`, `context`) rather than CRM/action/idea-first.
- Apple MCP tools for Mail/Notes/Calendar/Reminders already exist in `src/mcp/apple-mcp.ts`.
- No unified ingestion watchers yet for Notability/iCloud folders/email streams into a common extract pipeline.

### Related Systems
- **mix-assistant**: 100+ research files, thesis proposals, startup pitch decks. To be absorbed.
- **interface-web**: Hugo static site (denizaydemir.com). Logseq -> Hugo -> Render.
- **Codex**: Picks up GH issues hourly for coding. Independent.
- **thesis-sdm**: Completed MIT thesis. Past work.
- **project_echo** (armanaydemir): Brother's logs-first personal logging system. Reference for ideas.

## Design Topics

### 0. Unified Ingestion & Memory [DISCUSSED]
Status: Core architecture agreed. See SPEC-DRAFT.md and CONVERSATION-LOG.md.

### 0.5. Reality Baseline Audit [DISCUSSED]
Status: Completed in Session 2 (2026-02-19). Current code architecture mapped and documented in CONVERSATION-LOG.md.
Purpose: ensure 1.0 scope decisions reflect actual implemented system.

### 0.6. High-Level Architecture Shape [IN PROGRESS]
Status: Active. Priority is architecture before provider-level implementation detail.
Current leading idea: block-first graph (`blocks + edges`) with typed/entity layers as projections.
Latest refinement:
- Entity = derived block cluster (anchor + backlinks), not mandatory base table.
- Natural-language edge labels are acceptable if we preserve optional normalized edge kinds for deterministic workflows.
- DB strategy leaning: one physical DB with logical separation between human and AI-origin blocks.

### 0.7. Minimal Action Primitives [IN PROGRESS]
Status: Active. Defining the smallest deterministic layer needed for CRM/task/calendar automations.
Current options under discussion:
- Tags-only behavior
- Types/state as first-class blocks
- Hybrid: freeform blocks + small normalized type/state/edge/time rails
Latest refinement:
- Tags are block references; reserved `muavin/*` type blocks can drive runtime behavior.
- Aim: tiny behavior kernel + generic execution contract to avoid overfitting.
- New direction under evaluation: remove heavy namespace bias and use first-principles lightweight labels (`[[email]]`, `[[draft]]`, `[[todo]]`) with derived CRM views anchored on person blocks like `[[bob]]`.

### 0.8. Intent Clarification Loop [IN PROGRESS]
Status: Active. Defining how Muavin handles ambiguous natural-language action inputs.
Current direction:
- Infer target/action/actionability from freeform blocks.
- Ask clarifying questions via Telegram when confidence is low.
- Create internal Muavin work-note blocks once resolved.
- Drive dashboard/CRM from those work-note projections.

### 0.9. Muavin-Created Blocks [IN PROGRESS]
Status: Active. Defining minimal internal block types Muavin creates to support execution and observability.
Current proposed set:
- `work_item`, `clarification`, `draft`, `research_note`, `cannot_execute`, `job`, `job_run`, `insight`

### 0.10. Writing Interface [IN PROGRESS]
Status: Active. User is leaning toward a TUI-first note-writing surface with Muavin invocation alongside writing.
Scope note:
- Coding-work integration is intentionally out-of-scope in this phase.

### 0.11. Linking Substrate [DISCUSSED]
Status: Recommendation set. Canonical graph is explicit links/backlinks. Vector inference is advisory, surfaced as suggestions and ranking signal.

### 0.12. Nesting Primitive [DISCUSSED]
Status: Decision: keep hierarchy non-mandatory in base schema; support through explicit edges and optional derived ancestry.

### 0.13. Block Granularity [DISCUSSED]
Status: Decision set. Canonical storage for outline regions is one block per bullet/item.

### 0.14. Serialization Strategy [IN PROGRESS]
Status: Active. Evaluating input normalization rules for freeform chunked text vs outliner syntax.
Current direction:
- treat delimiter-only or mixed markdown input as ingest format
- normalize to per-bullet blocks where possible
- preserve UI-level outliner typing flow for ergonomics

### 0.15. Writing Modes [IN PROGRESS]
Status: Active. Defining UX modes for scratch capture vs stable document work.
Current direction:
- keep one substrate (`block` + `edge`)
- introduce container-level `content_profile` (`scratch`, `document`)
- map random notes to scratch containers, thesis/docs to document containers

### 0.16. Content Profiles + Rendering [IN PROGRESS]
Status: Active. Deciding whether document rendering structure is explicit everywhere or profile-scoped.
Current direction:
- blocks stay the base content chunk unit.
- renderer selection (scratch/outline/markdown/latex) is orthogonal to extraction and storage.
- explicit structural edges may be profile-scoped to document containers first.

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
- Autonomy boundary (explicitly deferred until after core architecture decisions)
