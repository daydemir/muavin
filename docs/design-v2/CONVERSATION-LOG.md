# Design Conversation Log

## Session 1 — 2026-02-18

### Topic 0: Unified Ingestion & Memory

**Storage discussion:**
- Notability exports PDFs + audio to iCloud automatically when connected, possibly also Dropbox
- Discussed storage options: iCloud (already works), S3/R2 (programmatic but adds complexity), local folder
- Decision: local folder as inbox is simplest — iCloud syncs to Mac, muavin watches local folder
- Files don't need to be accessible from anywhere beyond Mac + iCloud
- Better backup system needed beyond iCloud — to figure out later

**Raw data types identified:**
1. PDFs from handwritten notes (Notability)
2. Audio files (Notability recordings)
3. Text notes (Logseq/Obsidian)
4. AI research artifacts (tied to notes, mix-assistant is subset)
5. Emails (normal email system)
6. Apple Reminders, Notes
7. Verbatim log of conversations/thoughts (→ collapses into text notes)
8. Messages, other inboxes
9. Website content
10. Published content (notes, thesis, etc.)
11. Draft content being worked toward completion

**Key insight from Deniz:** "maybe I don't have conversations, instead I take notes and mua just extracts actions"

**project_echo reference:** Brother's repo (armanaydemir/project_echo) — logs-first personal logging system. Express + JSONL + vanilla JS + Ollama. Core idea: logs are the atomic unit, everything derives from them. Good instinct but Deniz already has input surfaces (notes app, Telegram, Reminders).

**Simplification:** 12 source types collapse into 4 processing patterns (files in folder, text written, messages from others, structured items). "Extract" always means: people, action items, ideas, decisions, open questions.

**Two modes agreed:**
1. **Passive**: Muavin watches, extracts, stores, surfaces
2. **Active**: Deniz works live with muavin as thinking partner — same pipeline but interactive

**Open design questions raised by Deniz:**
- How muavin adds its own thoughts without interfering with human-written content
- Could potentially replace Logseq with custom input app (on the horizon)
- Wants action prioritization based on all inputs
- Wants a "solid DB of my whole life" — all inputs stored durably
- Start simple (like project_echo — just reminders or md notes) and add components incrementally

### Muavin's Annotation Model

**How muavin adds thoughts without touching human files:**
- Ruled out: inline edits, appending sections to human files
- Considered: companion files (`note.muavin.md`), separate vault with cross-links, separate DB-only space
- Leading idea: **`life/.muavin/` pattern** — one folder tree for everything (`life/`), muavin's thoughts and actions live in `life/.muavin/` and reference files in `life/` via relative paths. No vault boundary problems, cross-linking is just paths within the same tree.
- Also valid: muavin's analysis lives only in Supabase/dashboard, never on disk at all
- TBD: flesh out further

### Writing Support & Thesis Use Case (First Target)

**Where thesis/research content lives today:**
- `thesis-sdm` repo — the written thesis, outlines
- `daydemir/life` repo (Logseq) — years of exploratory notes on everything
- `mix-assistant` repo — thesis thinking in context of MIX startup
- These three need to be unified. Muavin could obviate all of them. The new system might even become the note-taking system itself.

**What "thinking with writing" looks like for Deniz:**
- Block-based notes with linking between concepts
- Stepping away, doing handwriting to figure out structures
- Jumping in to do research
- Non-linear, iterative process

**What muavin should do (active mode):**
- Deniz writes and ideates freely
- Then invokes muavin on a specific note: "find academic references that support or oppose this claim"
- Muavin looks around the knowledge base, does research, offers thoughts
- Chat-based interaction is fine — doesn't need to be inline
- Key: muavin can quickly see what Deniz is working on and offer relevant input

**Shared access files:**
- Some files should be read/write for both Deniz and muavin (not just Deniz-writes / muavin-reads)
- This is a nuance on the "AI never edits human text" principle — some files are collaborative artifacts
- Needs more thought on how to distinguish "my text" from "shared workspace" files

**Decision: don't over-engineer this now.** The core need is clear — muavin as a research/thinking partner you can invoke on your current writing context. Implementation details (inline vs chat, file watching vs on-demand) can be simple first.

### Topics remaining:
1. CRM & Contacts
2. Reminders → CRM Pipeline
3. Email Watching
4. Writing Support
5. Notes → Website Pipeline
6. Dashboard
7. Codex / Coding Integration

Plus cross-cutting: privacy/publish gate, muavin annotation model, prioritization engine.

---

## Session 2 — 2026-02-19

### Topic: "What is Muavin right now?" (Codebase Reality Check)

Goal of this session: align spec work with actual implementation so Muavin 1.0 planning is grounded.

**Current implemented core (as of 2026-02-19):**
- Telegram-first relay (`src/relay.ts`) is the main user interface.
- Claude CLI subprocess orchestration exists (`src/claude.ts`) with sessions, timeouts, and model selection.
- Supabase memory exists with two main tables:
  - `messages`: full conversation log with embeddings
  - `memory`: extracted facts (currently generic types: personal_fact/preference/goal/relationship/context)
- Background execution layer exists:
  - Jobs (`src/jobs.ts`, `src/run-job.ts`)
  - Agents (`src/agents.ts`)
  - Outbox mediation and delivery filtering (SKIP-aware)
- Reliability/ops layer exists:
  - Heartbeat daemon (`src/heartbeat.ts`)
  - Locking, launchd sync, self-healing attempts, stale lock cleanup
- CLI is mature for setup/start/stop/status/config/test/agent management (`src/cli.ts`).

**What already exists but is not integrated into the v2 spec yet:**
- Apple MCP server (`src/mcp/apple-mcp.ts`) includes tools for:
  - Mail (search/read/archive/create draft)
  - Notes (search/read/create)
  - Calendar (list/create)
  - Reminders (lists/search/create/complete)
- This is important because email/reminders/calendar integration may be faster to ship via this path than building new ingestion connectors first.

**Observed gaps vs design-v2 draft vision:**
1. No generalized multi-source ingestion pipeline yet (folder watches, Notability OCR/transcribe, email ingestion into unified memory).
2. No CRM schema yet (people, relationship state, touchpoint policy, reminders linkage).
3. No first-class action/decision/question/idea schema yet (beyond generic memory extraction).
4. No prioritization engine that ranks cross-source actions.
5. No web dashboard product surface yet.
6. No explicit publish-gate implementation for notes -> website flow.
7. No settled model for "human-owned files vs shared collaborative files" in storage layer.

**Operational caveats discovered during audit:**
- `.mcp.json` currently points `muavin-apple` to `cwd: /Users/deniz/Build/deniz/claw` instead of this repo path. This may be intentional legacy setup or stale config, but should be clarified before relying on MCP in 1.0 plans.

### Decisions made in this session
- No product decisions finalized yet.
- Agreed process: continue this conversation iteratively and update docs after each block of decisions.
- Historical notes from Session 1 are kept intact; new sessions append only (archive-by-append model).

### Immediate clarification queue for next discussion block
1. **Version naming**: Are we treating "Muavin 1.0" as the current next milestone while these docs still live under `design-v2`, or should docs be renamed now?
2. **1.0 surface area**: Should 1.0 be a "Telegram + ingestion + prioritization" release first, with dashboard later?
3. **Integration strategy**: For email/reminders/calendar, do we prioritize Apple MCP tools first or direct provider APIs first?
4. **Memory model step-1**: Which structured entities are required in 1.0 schema (minimum viable set)?
5. **Execution model**: Which actions are "draft only" vs "auto-executable" in 1.0?

---

## Session 3 — 2026-02-19

### Topic: Muavin 1.0 framing + architecture-first discussion

**User decisions/inputs:**
1. Naming clarified: this is Muavin **1.0**, not v2.
2. Prioritization clarified: discuss high-level architecture first; provider-specific implementation details come later.
3. Strong idea raised: model everything as typed notes/entities while preserving free-form writing in Logseq/Obsidian-like tools.
4. Autonomy boundary (draft-only vs auto-execute) is intentionally postponed until after architecture is set.

### Architecture idea added (leading candidate)

**"Everything is a typed note"**
- User writes freely in notes/transcripts/messages.
- Muavin parses those into block/atom units.
- Atoms are converted into typed entities in DB.
- Muavin then organizes, links, prioritizes, and drafts from those entities.

Potential minimum entity set for 1.0 discussion:
- `person`
- `action`
- `idea`
- `decision`
- `open_question`
- `source_ref` (traceability metadata)

### OpenClaw use-case follow-up research completed

Requested thread reviewed:
- `https://github.com/daydemir/muavin/issues/53` (OpenClaw use-case extraction task)
- Follow-on references inside issue chain:
  - `#85` (transcript/notes extraction flow)
  - `#83` (cost tracking)

Additional resources reviewed:
- Video transcript source from issue #53:
  - `https://youtu.be/Q7r--i9lLck?si=ea73KHD70ySRXlsp`
- Prompt pack resource:
  - `https://gist.github.com/mberman84/065631c62d6d8f30ecb14748c00fc6d9`
- ForwardFuture use-case page:
  - `https://www.forwardfuture.ai/p/what-people-are-actually-doing-with-openclaw-25-use-cases`

### High-level learnings from that research (architecture-relevant)

- Reusable workflow primitives outperform one-off automations.
- Daily ingestion + dedupe + typed extraction enable many downstream capabilities (CRM, meeting prep, tasking, briefings).
- Cost/usage tracking should be built early.
- Reliability/ops (health checks, backups, restore docs) are core product capabilities for an always-on assistant.
- Session/channel isolation matters for privacy and context quality when multiple channels are used.

### Use-case families observed in transcript/resources

1. CRM ingestion + relationship intelligence
2. Knowledge base ingestion + retrieval
3. Meeting/transcript -> action extraction
4. Content/research pipelines with dedupe
5. Cost/usage tracking
6. Reliability + backup/restore operations

### Muavin 1.0 relevance cut (initial)

**Likely in 1.0 architecture scope:**
- typed extraction from free-form notes/transcripts/messages
- CRM + action views over shared memory
- cost/usage instrumentation
- reliability baseline (health + backups)

**Likely post-1.0 or optional:**
- heavy social-media intelligence stacks
- image/video generation workflows
- multi-agent "council" briefing systems

### Immediate next architecture questions

1. What is the canonical note atom format before typing (block schema + provenance)?
2. Should typed entities be append-only with superseding links, or mutable upserts?
3. What is the minimum viable read model for prioritization (action queue + people timeline + idea index)?
4. Which surfaces are in 1.0 MVP: Telegram-only first, or Telegram plus lightweight web dashboard?

---

## Session 4 — 2026-02-19

### Topic: Generic blocks as primary data model

User proposal:
- Treat everything as generic blocks populated from heterogeneous sources (Logseq, reminders, calendar, Telegram, etc.).
- Muavin's job is to negotiate between these blocks.
- Types can exist, but not as the first architectural constraint.

Discussion outcome:
- This is a strong direction and compatible with "typed notes" if typing is treated as a later layer, not the ingest primitive.
- We should first minimize the number of fundamental structures and only add typed canonicalization where needed.

Proposed structure count:

**Minimum bootstrap (3):**
1. `artifacts`
2. `blocks`
3. `claims`

**Likely stable core (6):**
1. `artifacts`
2. `blocks`
3. `claims`
4. `entities`
5. `edges`
6. `resolutions`

Key interpretation:
- Blocks are the shared substrate.
- "Negotiation" is explicitly represented as claim resolution, not hidden prompt behavior.

---

## Session 5 — 2026-02-19

### Topic: Claims vs blocks, and whether entities/resolutions are necessary

User feedback:
- Claims should probably be a type of block.
- Unclear why separate `entities` and `resolutions` are needed.
- Block-to-block references make sense; detailed mechanics can be decided later.

Clarification outcome:
- Agreed: claims become block type (not separate base structure).
- Core model is simplified to:
  1. `blocks`
  2. `edges`
- `entities` and `resolutions` are reframed as optional derived views/projections, not mandatory first-class tables.

Current architecture stance:
- Start with `blocks + edges`.
- Add higher-order projections only if needed for performance/usability.

---

## Session 6 — 2026-02-19

### Topic: Backlink entities, natural-language edges, and DB topology

User direction:
- Keep Muavin 1.0 architecture block-first.
- Treat entities as implicit via backlink structure:
  - entity ~= anchor block + backlinks/related blocks.
- Resolutions are deferred (too granular for now).
- Lean toward natural-language edges and letting AI infer semantics.
- Asked for explicit downsides of fully block-based systems and tradeoffs for:
  - one DB vs two DBs (human input DB + AI DB).

Research follow-up completed (official docs where available):
- Logseq docs (block references, embeds, DB graph notes):
  - `https://github.com/logseq/docs/blob/master/pages/Block%20Reference.md`
  - `https://github.com/logseq/docs/blob/master/pages/The%20basics%20of%20block%20references.md`
  - `https://github.com/logseq/docs/blob/master/pages/The%20difference%20between%20block%20embeds%20and%20block%20references.md`
  - `https://github.com/logseq/docs/blob/master/db-version.md`
- Obsidian help docs (internal links, block links, embeds, backlinks/unlinked mentions):
  - `https://help.obsidian.md/Linking+notes+and+files/Internal+links`
  - `https://help.obsidian.md/Linking+notes+and+files/Embed+files`
  - `https://help.obsidian.md/Plugins/Backlinks`
- Tana docs/pages (nodes/references, supertags, node types):
  - `https://tana.inc/docs/nodes-and-references`
  - `https://tana.inc/docs/supertags`
  - `https://tana.inc/docs/node-types`
- Roam official positioning page:
  - `https://roamresearch.com`

Project Echo follow-up:
- Local clone not found in current machine paths searched.
- Direct GitHub repo lookup by the previously referenced path was not retrievable in this pass (likely moved/private/renamed).
- Existing design takeaway from earlier sessions remains: logs-first substrate is a useful simplification pattern.

Architecture clarification outcome:
1. Core substrate remains:
   - `blocks`
   - `edges`
2. `entities` become derived/materialized views over block clusters (not base schema).
3. `resolutions` remain deferred and optional.
4. Edge representation should preserve:
   - original natural-language label
   - optional normalized edge kind + confidence (derived)

Tradeoff summary captured:
- Fully block-only systems are flexible but risk semantic drift, duplicate sprawl, query instability, and high AI interpretation cost if no thin canonical rails exist.
- Single DB is favored for 1.0 velocity and cross-source joins.
- Two DBs improve isolation but add major sync/join/consistency complexity.

Working recommendation for Muavin 1.0:
- One physical DB.
- Logical separation via origin/lifecycle/visibility fields (human vs AI rows).
- Strong provenance edges from AI blocks back to source blocks.
- Revisit physical split only if privacy/compliance constraints require it.

---

## Session 7 — 2026-02-19

### Topic: Project Echo clone validation + minimal edge/state primitives for action workflows

User input:
- Clone and inspect `project_echo` directly:
  - `https://github.com/armanaydemir/project_echo`
- Discuss minimal primitives needed for action-driving behavior (CRM jobs, email drafting, calendar-driven actions).
- Consider whether "types are blocks/tags" is enough.

Project Echo verification (completed):
- Cloned successfully to temp path:
  - `/tmp/project_echo.1AGWpe`
- Inspected commit:
  - `22edb7a`
- Key observed model:
  1. Logs are the only input substrate.
  2. Tags drive organization and review (`needs review` default tag).
  3. Privacy handled via `private` tag.
  4. Edit history kept per log (`versions` array).
  5. Local-first storage in `logs.jsonl` + `tags.json`.

Most relevant lesson for Muavin 1.0:
- A single universal substrate plus a small set of workflow tags/states can ship quickly.
- But reliable automation still needs a thin normalized layer.

Architecture options discussed:
1. Tags-only
- Fastest and most flexible.
- Weak determinism for jobs unless conventions are very strict.

2. Types-as-blocks
- Preserves "everything is a block."
- Requires behavior engine + materialized read models for dependable automation.

3. Hybrid (current recommendation)
- Keep freeform block capture and natural language linking.
- Add minimal machine rails for execution:
  - reserved type/state tags (or equivalent type/state blocks)
  - minimal temporal fields (`due_at`, `start_at`, `end_at`, `completed_at`)
  - small normalized edge set (`about`, `derived_from`, `depends_on`, `scheduled_for`, `assigned_to`, `supersedes`).

Open decision for next step:
- Should type/state be implemented in 1.0 as:
  1. Reserved tags only
  2. Dedicated type/state blocks
  3. Dual model (tags at write-time, mapped to type/state blocks in normalization)

---

## Session 8 — 2026-02-19

### Topic: Extensibility without overfitting (tags as blocks + behavior triggers)

User clarification:
- Tags are also blocks.
- We can hardcode behavior for certain special blocks/tags.
- Example: `[[muavin/job]]` should mark a block as a job intent that triggers Muavin behavior.
- Open concern: how to keep this very extensible and useful without over-customization/overfit.

Architecture refinement:
1. Keep `blocks + edges` substrate unchanged.
2. Treat tag/type references as block links (no separate tag primitive).
3. Introduce reserved behavior namespaces (for example `muavin/*`) that runtime understands.
4. Keep all non-reserved user tags/types inert by default unless mapped later.

Proposed 1.0 execution model:
- Tiny hardcoded behavior kernel for high-value workflows only:
  - `muavin/job`
  - `muavin/person` (CRM contexting/follow-up)
  - `muavin/event` (time/event orchestration)
  - `muavin/state/*`
- Any trigger creates draft/action blocks via one generic execution contract (with provenance + explanation), rather than bespoke per-feature pipelines.

Overfit prevention strategy:
1. Unknown type/tag blocks remain normal notes (no breakage).
2. New behaviors are additive (new blocks/edges), not destructive edits.
3. Optional policy blocks can express "when X then Y" rules later, enabling "just tell mua" customization without schema churn.

Working recommendation:
- Ship Muavin 1.0 with a small behavior registry + reserved namespaces.
- Preserve freeform capture and natural-language linking everywhere else.

---

## Session 9 — 2026-02-19

### Topic: First-principles model (avoid heavy type namespace)

User feedback:
- Wants "everything is a block" similar to Tana.
- Dislikes heavy naming like `muavin/person`.
- Requested a first-principles walkthrough using example notes referencing `[[bob]]`.
- Key questions:
  1. How to track "email Bob" in CRM?
  2. How to surface linked notes?
  3. How to write drafts?

Resulting direction:
1. Keep primitives minimal:
  - blocks
  - references/backlinks
  - lightweight semantic labels (also blocks): `[[email]]`, `[[draft]]`, `[[thesis]]`, `[[todo]]`, `[[done]]`.
2. `[[bob]]` is just a normal block/node used as anchor for derived views.
3. CRM is a derived projection over the `[[bob]]` cluster, not a heavy first-class input schema.

Derived CRM logic for Bob (non-exhaustive):
- `last_contact_at`: latest communication block linked to `[[bob]]` and `[[email]]` (or future channel labels).
- `open_threads`: `[[bob]]`-linked blocks with unresolved markers (`[[todo]]` and equivalents).
- `recent_topics`: co-referenced thematic tags like `[[thesis]]`.

Linked-note surfacing pattern:
1. Anchor on `[[bob]]`.
2. Pull backlinks + nearby context.
3. Rank by recency + communication relevance + topic overlap + unresolved state.

Draft pattern:
1. User asks for a draft.
2. Muavin gathers context from linked Bob/thesis blocks.
3. Muavin writes a new `[[draft]]` + `[[email]]` block linked to source blocks and `[[bob]]`.
4. User edits/approves (draft-first policy).

---

## Session 10 — 2026-02-19

### Topic: Ambiguous action inference ("email bob") and internal work tracking

User clarification:
- Inputs may be messy/unstructured (for example reminders not properly tagged).
- Muavin should infer:
  1. who "bob" is
  2. that "email bob" is an actionable instruction with action type `email`
- If uncertain, Muavin should ask follow-up via Telegram.
- Once confident, Muavin should create an associated Muavin DB note to track the work.
- That tracked work should surface in dashboard/CRM views.

Decision:
- Yes, this is a strong 1.0 pattern and compatible with first-principles block architecture.

Proposed runtime loop:
1. Ingest source block.
2. Infer target/action/actionability.
3. If low confidence, create clarification prompt via Telegram.
4. On resolution, create internal Muavin work-note block linked to source + target.
5. Dashboard and CRM are derived projections over these work notes and linked source clusters.

Minimal deterministic work-note payload:
- source refs
- target ref (resolved person/entity block)
- action label
- state (`needs_clarification`, `queued`, `draft_ready`, `done`, etc.)
- confidence + explanation
- optional draft ref

---

## Session 11 — 2026-02-19

### Topic: Minimal Muavin-created block types + v1 flow coverage + note-writing interface

User request:
- If all user input is block-first, define what Muavin-created block types should exist.
- Ensure support for:
  1. CRM email task (`email bob` with linked Bob context)
  2. Reminder Muavin can execute (`research X` into notes)
  3. Reminder Muavin cannot execute (`read book`)
  4. Recurring notes job (nightly thesis references/critiques/improvements)
  5. Recurring CRM job (certain inbound email -> draft reply)
- Suggest additional candidate v1 flows for accept/reject.
- Product direction note:
  - Coding work is out-of-scope for now.
  - Wants an interface for writing notes with Muavin nearby (likely TUI-first for thesis + personal notes).

Proposed minimal Muavin-created block types:
1. `work_item`
2. `clarification`
3. `draft`
4. `research_note`
5. `cannot_execute`
6. `job`
7. `job_run`
8. `insight`

Flow mapping:
- CRM email task: `work_item` -> optional `clarification` -> `draft`
- Research task: `work_item` -> `research_note` (+ optional `insight`)
- Cannot-do reminder: `work_item` + `cannot_execute` (+ optional plan/checklist)
- Nightly thesis job: `job` -> `job_run` -> `insight` (+ optional `work_item`)
- CRM auto-draft job: `job` -> `job_run` -> `draft` (+ optional review `work_item`)

Additional candidate flows proposed for v1 inclusion decision:
1. Meeting prep pack
2. Relationship ping suggestions
3. Weekly thesis digest
4. Claim contradiction detector
5. Inbox triage
6. Follow-up tracker after sent drafts

---

## Session 12 — 2026-02-19

### Topic: TUI-first writing surface + explicit links vs vector-inferred backlinks

User direction:
- Potentially wind back further to first principles.
- Define what a note-writing TUI should look like.
- Questioned whether explicit linking is even required if Muavin can do vector tagging/backlink inference.
- Requested research-backed pros/cons of:
  - vector DB semantic linking/tagging
  - direct explicit tagging/linking
- Asked specifically how much worse vector-only backlinks would be.

Working architecture answer:
1. TUI should be writing-first (editor primary), with sidecar context + Muavin action panel + work queue toggle.
2. For linking, use a dual graph:
  - explicit links as source-of-truth graph
  - vector-inferred links as suggestion/expansion layer
3. Do not use vector-only backlinks as sole truth for execution-critical workflows.

Reasoning summary:
- Explicit links are deterministic and auditable.
- Vector retrieval is powerful for discovery but less stable for exact entity/action workflows.
- Hybrid retrieval + metadata filtering is broadly recommended by vector DB vendors because dense-only retrieval has known failure modes.

Current recommendation for Muavin 1.0:
- Keep explicit backlinks/links as canonical workflow substrate.
- Use vector layer to suggest missing links, rank context, and discover related notes.
- Allow user promotion of inferred links into explicit graph edges.

## Session 13 — 2026-02-20

### Topic: Block nesting as primitive or relation?

User clarification:
- Daily writing should often start from a blank surface.
- Desire: block-first flow similar to Tana/Logseq/Obsidian, without heavy upfront typing.
- Question: should `parent` be a first-class field, or keep nesting as an optional structure?

Decision direction:
- Keep v1 writing surface minimal and high velocity.
- Support nesting ergonomics in UI (indent/reveal, fold/unfold, bullet depth).
- Persist hierarchy as explicit relations (`contains`, `follows`, or similar) rather than as a mandatory parent pointer in base schema.
- Treat `parent_id`/path-like ancestry as derived, optional, or added later if profiling demands.

Why this is preferred for v1:
1. avoids locking users into rigid hierarchy semantics early
2. keeps execution workflows simpler by relying on explicit edge contracts (`work_item`, `draft`, `clarification`, `assigned_to`, etc.)
3. keeps "everything is a block" consistency with semantic intent still captured by tags/labels and references
4. leaves room to move to true structural hierarchy only if real UX performance issues appear

Implications to capture in implementation notes:
- `block` remains canonical capture unit from all sources
- `edges` remains primary relationship primitive
- nested view is a projection over `contains`-like edges + ordering metadata

## Session 14 — 2026-02-20

### Topic: Outliner block granularity (one block vs per-bullet blocks)

User question:
- In outline writing (for example `section -> idea` nesting), should all bullets be one block or separate blocks?
- UX preference mentioned for a single uninterrupted outline typing experience.

Decision direction:
- keep outliner feel in UI with indentation, folding, and reorder.
- persist each bullet/list item as its own block.
- persist hierarchy via `contains` + `follows` edges and optional `indent_level`.
- keep monolithic block for the whole outline only as temporary editor draft if needed.

Rationale:
1. precise linking/reference on one idea instead of whole section
2. easier deterministic actioning (`email bob` tied to one specific idea block)
3. safer edits and dedupe at fine granularity
4. clear move/reorder semantics through graph updates
5. preserves compatibility with Logseq/Obsidian semantics without forcing rigid hierarchy as base schema

Open follow-up:
- decide if `indent_level` is derived from edges at render-time or materialized in block fields.

## Session 15 — 2026-02-20

### Topic: Block separator model vs per-bullet block model

User comparison:
- Style A: use explicit separators between top-level blocks, with an outline block containing nested markdown lines.
- Style B: use bullet prefix for every block (Logseq style), making each bullet a block node.

Decision notes and tradeoffs:

1) Delimiter-based top-level blocks (style A)
- Semantics:
  - top-level blocks are split by `---` (or blank-line groups)
  - outline lives as an opaque text blob inside one parent block
- Pros:
  - very low write-time complexity for a human; simple mental model
  - fast import from linear plain text sources and transcripts
  - fewer block IDs/graph edges for minimal surfaces
- Cons:
  - weaker actionability: one edit references one whole region
  - hard to target references or backlinks to `idea 1` inside nested outline text
  - harder deterministic extraction for CRM/email tasks
  - reordering ideas requires text-level parsing, harder to preserve provenance

2) Bullet-per-item blocks (style B)
- Semantics:
  - each bullet becomes a block node
  - hierarchy via explicit `contains`/`follows` edges and indent metadata
- Pros:
  - fine-grained execution (action/task references can point to one idea)
  - easier deterministic reranking, dedupe, and provenance tracking
  - move/reorder operations become graph mutations (clearer undo/history)
  - cleaner downstream workflows (`email bob` attaches to one block context)
  - aligns better with block-first query/graph model for Muavin 1.0
- Cons:
  - parser complexity is higher than delimiter-only chunking
  - requires UI conventions for editing contiguous outliner runs
  - can feel over-fragmented unless renderer re-groups blocks visually

Working recommendation for Muavin 1.0:
- Parse and persist one block per bullet/item for outline regions.
- Keep raw separator-based style as allowed input for ingestion/back-compat, but normalize to bullet/block nodes where possible.
- Keep editing ergonomics outliner-like so users can still write in one flowing rhythm.

## Session 16 — 2026-02-20

### Topic: Stable document vs scratch note model without schema fork

User tension:
- need daily capture speed for misc thoughts and mixed inputs
- need stable medium- and long-form workflows for thesis and iterative writing
- want both outliner benefits and durable doc-like authoring in one system

Discussion and decision direction:
- keep universal block+edge substrate
- add container-level modes instead of separate schemas
- `note_container` acts as durable parent for doc-like work
- `leaf_block` nodes remain atomic for extraction/linking/actioning
- container has `content_profile`:
  - `scratch`: minimal structural commitments, fast input
  - `document`: stronger section/heading semantics and stable outline behavior

Implications:
- thesis work can run in document mode with stable sections
- day notes can stay in scratch mode with minimal friction
- both modes share the same parser and indexing pipeline

Open decisions to finalize tomorrow:
- default container mode for new sessions
- when and how to auto-promote scratch content into document mode
- how to preserve latex/markdown fidelity in document mode while keeping extraction clean
- surface for mode switching (explicit toggle vs heuristic)

## Session 17 — 2026-02-20

### Topic: Blocks as chunked content with render profiles

User direction:
- block should be a content chunk (paragraph/item/fragment level)
- documents can be sequences/trees of chunks with different render profiles (markdown, outline, thesis-doc)
- key open point: keep nesting for proper rendering/editing semantics, not just as inferential sugar

Interpretation:
- storage remains content blocks + edges; rendering mode is an orthogonal concern
- block-level atomicity gives fine-grained linking, action extraction, and provenance
- render profile controls whether the same block graph appears as day notes, outliner, or stable thesis draft

Decision notes:
- explicit structural metadata/edges for documents improves deterministic reorders and edit diffing
- render-only nesting is simpler but risks weaker provenance for long-form rearrangements
- pragmatic v1 posture: chunk blocks always, explicit ordering/containment where document-mode needs it

Open decision:
- whether explicit nesting metadata should be always-on for document-mode only or always-on globally
