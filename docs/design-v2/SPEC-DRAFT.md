# Muavin 1.0: Design Spec (Draft)

Status: In progress — working through topics with Deniz.

## Core Concept

Muavin is a **personal chief of staff** — a unified ingestion + synthesis system that pulls in everything Deniz is thinking and experiencing, stores it as a lifelong database, and helps produce outputs (actions, drafts, published content, connections).

## High-Level Architecture

```
INPUTS → EXTRACT → MEMORY (Supabase) → SURFACE / PRODUCE → OUTPUTS
```

## Current Implementation Snapshot (2026-02-19)

This draft describes the target direction. Current codebase status:

- Strongly implemented: Telegram relay, Claude subprocess orchestration, jobs/agents/outbox pipeline, Supabase message+memory storage, heartbeat/ops.
- Partially implemented: Apple MCP tooling for Mail/Notes/Calendar/Reminders exists, but full ingestion architecture is not yet spec-locked.
- Not yet implemented: unified multi-source ingestion watchers, CRM-first schema, cross-source prioritization engine, dashboard product surface, publish-gate pipeline.

Planning note: milestone naming is now decided. This is the Muavin 1.0 planning track. (`design-v2` folder name is legacy and can be renamed later.)

## High-Level Architecture Direction (Current Leading Idea)

### "Everything is a typed note"

New architectural hypothesis from Session 3:
- Deniz can keep writing freely in tools like Logseq/Obsidian (or future custom input).
- Muavin treats every captured unit (note block, transcript segment, email chunk, reminder, message, PDF chunk) as a **note atom**.
- Each note atom is mapped to one or more **typed entities** in a structured DB.

Proposed canonical flow:
1. Source adapters ingest raw artifacts.
2. Artifact parser normalizes content into note atoms with provenance metadata.
3. Typing layer assigns entity types and links:
   - `person`
   - `action`
   - `idea`
   - `decision`
   - `open_question`
   - `source_ref` (for traceability)
4. Graph/materialized views support retrieval, prioritization, and drafting workflows.
5. Muavin surfaces ranked actions, connections, and drafts through Telegram first; dashboard later.

Why this matters:
- Preserves free-form writing while enabling structured automation.
- Avoids forcing rigid input behavior at capture time.
- Supports both passive ingestion and active "think with me" mode.
- Keeps provenance intact: every structured entity can point back to original human notes/transcripts.

## Block-First Data Model (refinement)

### Principle

Start with generic blocks from every source. Type system can be layered on later.

Sources feeding blocks:
- Logseq/Obsidian notes
- Reminders
- Calendar events
- Telegram messages
- Email/messages
- Transcript segments

### Minimal core structures

1. `blocks`
- Universal unit for everything (raw notes, reminders, calendar events, Telegram messages, extracted claims, summaries).
- Claims are not a separate structure; they are `blocks.kind = "claim"` (or similar).
- Each block carries provenance fields (source, source_id, timestamps, author, ingestion metadata).

2. `edges`
- Generic references between blocks.
- Examples: `derived_from`, `references`, `contradicts`, `supersedes`, `about`, `duplicates`.

### Why this is enough to start

- Single storage primitive keeps ingestion simple.
- "Negotiation" is represented explicitly via edges and block status, not hidden in prompts.
- New behavior can be introduced by new block kinds and edge kinds without schema churn.

### What `entities` and `resolutions` become in this model

- `entities`: optional derived view over blocks (for example, grouped person/action records), not a required base table.
- `resolutions`: optional derived view/log built from contradiction/supersede edges and ranking rules.

In other words: start with `blocks + edges`; treat entity and resolution layers as projections if/when needed.

### Backlink-Derived Entities (current direction)

Working definition:
- An entity is not a separate primitive.
- An entity is a **derived cluster**: one anchor block plus its backlinks/related edges.

Implication:
- We do not need an `entities` base table in phase 1.
- We can materialize entity views later for speed/UX (`person view`, `project view`, etc.).

### Edge Semantics: Natural Language First

Current preference:
- Let edges be expressed in natural language initially (or loosely typed text labels).
- Use AI to infer semantic intent when needed.

Pragmatic guardrail to avoid chaos:
- Store both:
  - `edge_label_text` (human/NL original)
  - optional `edge_kind` + `confidence` (AI-normalized projection)

This keeps flexibility without locking Muavin into opaque, non-repeatable behavior.

### Risks of Fully Block-Based Systems (from Logseq/Tana/Roam/Obsidian patterns)

Main failure modes to plan for:
1. Semantic drift
- If everything is just a block, two similar ideas/actions/people can fragment into parallel clusters.

2. Query instability
- Purely free-form edge semantics makes deterministic filters/ranking harder (`what are overdue actions?`, `what changed for person X?`).

3. Duplicate explosion
- Multi-source ingestion (notes, reminders, messages, calendar) creates near-duplicates without strong dedupe/identity policy.

4. Cost/latency pressure
- If every read depends on AI interpretation of raw blocks/edges, retrieval becomes slower and more expensive.

5. Weak invariants
- Without minimal canonical fields, core workflows (task status, chronology, provenance) can become brittle.

6. UX ambiguity
- Users can lose trust when the same block appears in different inferred contexts with no clear reason.

Design takeaway:
- Keep `blocks + edges` as substrate, but add thin canonical rails for provenance, timestamps, actor/source identity, and optional normalized edge kinds.

### DB Topology Options (user question)

#### Option A: Single DB (recommended baseline)

Model:
- One database with one block graph, separated by fields:
  - `origin` (`human`, `ai`, `imported`)
  - `source_system` (logseq, telegram, reminders, calendar, etc.)
  - `visibility` / `sensitivity`
  - `lifecycle` (`raw`, `derived`, `archived`)

Pros:
- Easier joins across human and AI context.
- Simpler ranking/prioritization across all sources.
- Less sync and consistency overhead.
- Better lineage (every AI block can point to human source blocks in one graph).

Cons:
- Needs strict filtering so AI artifacts do not pollute user views.
- Requires clear ownership/editability rules.

#### Option B: Two DBs (user-input DB + AI DB)

Model:
- DB1: human/source-of-truth inputs
- DB2: AI interpretations, summaries, proposals, inferred edges

Pros:
- Strong isolation and safer deletion/retention boundaries.
- Easier to hard-separate private raw data from generated artifacts.

Cons:
- Cross-DB joins are painful and slow down product iteration.
- Higher risk of drift between AI and source-of-truth state.
- More complex backup/restore and consistency logic.

#### Recommended compromise

- Start with **one DB**, two logical namespaces:
  - `blocks_raw` / raw-origin rows
  - `blocks_ai` / AI-generated rows
- Keep hard provenance edges from AI rows to source rows.
- Add policy-level isolation (read filters, visibility flags, UI separation) before splitting physical databases.
- Only split to two physical DBs if compliance/privacy constraints force it later.

### Minimal Action Primitives for Muavin 1.0

Question driving this section:
- How little structure do we need so Muavin can still run reliable action workflows (CRM follow-ups, draft-email jobs, reminders/calendar handoff)?

#### Option 1: Tags-only behavior

Model:
- Everything is a block.
- Behavior is inferred from tags only (for example: `#action`, `#person`, `#event`, `#state/todo`, `#state/done`).

Pros:
- Maximum flexibility and lowest schema friction.
- Closest to Logseq/Tana-style freeform knowledge capture.

Cons:
- Harder deterministic queries for automation.
- Status transitions/history can become inconsistent without extra rules.

#### Option 2: Types-as-blocks

Model:
- Types themselves are blocks (`type/action`, `type/person`, `type/event`).
- State values are blocks (`state/todo`, `state/in_progress`, `state/done`).
- Instance blocks link to these via edges.

Pros:
- Keeps "everything is a block" purity.
- Extensible without migrations (new behavior can be introduced by creating new type/state blocks).

Cons:
- Requires policy engine to define what each type/state means operationally.
- Query complexity increases unless we materialize normalized read models.

#### Option 3 (recommended): Hybrid minimal rails

Model:
- Keep block-first and tag-friendly UX.
- Add a tiny machine layer for reliable automation.

Recommended minimum:
1. Reserved behavior tags (or linked type/state blocks):
  - `type/action`, `type/person`, `type/event`, `type/draft`
  - `state/inbox`, `state/todo`, `state/doing`, `state/done`, `state/canceled`
2. Minimal temporal fields on blocks:
  - `created_at`, `updated_at`, optional `due_at`, `start_at`, `end_at`, `completed_at`
3. Minimal normalized edge kinds (even if NL labels remain):
  - `about` (subject relation)
  - `derived_from` (provenance)
  - `depends_on` (task ordering/blocking)
  - `scheduled_for` (link action to event/time block)
  - `assigned_to` (owner/actor, useful for CRM workflows)
  - `supersedes` (newer block supersedes older one)

Practical note:
- User-facing creation can stay freeform (`blocks + natural language links + tags`).
- Normalization can run asynchronously and fill `edge_kind` / state fields for execution-grade jobs.

### Behavior Model: "Tags are blocks" with reserved namespaces

Current direction:
- Tags are blocks.
- Certain tag/type blocks carry behavior contracts.
- Example: linking/tagging with `[[muavin/job]]` marks a block as executable job intent.

Goal:
- Make system extensible without per-feature schema forks.
- Keep baseline useful even if no custom behavior is defined.

#### Extensibility pattern (recommended)

1. Core substrate (stable)
- `blocks` + `edges` + minimal state/time/provenance rails.

2. Behavior tags/types (declarative)
- Reserved namespace for system behaviors:
  - `muavin/job`
  - `muavin/person`
  - `muavin/event`
  - `muavin/state/*`
- Non-reserved namespaces remain user/extensible and inert by default.

3. Behavior registry (small hardcoded kernel)
- Runtime has a small map:
  - behavior type -> evaluator -> planner
- Evaluator decides if a block should trigger.
- Planner produces a draft action/output block (never auto-send by default).

4. Policy blocks (optional, user-defined)
- User can define "when X then Y" blocks that Muavin compiles into runtime rules.
- This enables "just tell mua" workflows without adding tables.

#### Guardrails to avoid overfit

1. Unknown types do nothing
- If a tag/type has no registered behavior, block remains normal note memory.

2. One generic execution contract
- Any trigger resolves to the same contract:
  - `candidate_action` block
  - provenance edges
  - confidence + explanation
  - optional approval requirement

3. Keep kernel tiny in 1.0
- Hardcode only a few behavior types needed for clear value:
  - jobs/tasks
  - CRM follow-up suggestions
  - scheduled/event reminders
  - draft message/email generation

4. Prefer additive behavior, never destructive mutation
- New behavior creates new blocks/edges; existing source blocks stay intact.

### First-Principles Example: Bob + Thesis + CRM + Drafts

Input blocks (freeform, user-written):
- `[note 1 on thesis thoughts]`
- `[note 2 on thesis thoughts, also mentions [bob]]`
- `[note about something [bob] once said to me]`
- `[email [bob]]`

#### Minimal representation

Use only:
1. Blocks
2. References (block-to-block links)
3. A few lightweight semantic labels (which are also blocks), e.g.:
  - `[[email]]`
  - `[[draft]]`
  - `[[thesis]]`
  - `[[todo]]`, `[[done]]`

`[[bob]]` is just a block that many blocks reference.

#### CRM tracking without a heavy `person` type

Treat CRM as a **derived view** over the `[[bob]]` cluster:
- Pull all blocks that reference `[[bob]]` (direct backlinks).
- Add one-hop context (blocks connected to those blocks) when needed.
- Derive:
  - `last_contact_at` from latest communication block referencing `[[bob]]` + `[[email]]` (or message/call tags later)
  - `open_threads` from blocks linked to `[[bob]]` and `[[todo]]`/unresolved markers
  - `recent_topics` from co-referenced tags like `[[thesis]]`

No dedicated CRM table is required at capture time.

#### Surfacing linked notes

For "show me everything relevant to emailing Bob":
1. Anchor on `[[bob]]`.
2. Fetch recent backlinks to `[[bob]]`.
3. Re-rank by:
  - recency
  - communication relevance (`[[email]]`, `[[meeting]]`, etc.)
  - topic overlap (`[[thesis]]`)
  - unresolved status (`[[todo]]` over `[[done]]`)

This yields a contextual bundle of notes + emails + tasks.

#### Writing a draft

Draft flow:
1. User asks: "draft email to bob about thesis update."
2. Muavin collects the `[[bob]]` cluster and thesis-related linked blocks.
3. Muavin creates a new block tagged `[[draft]]` and `[[email]]`, linked to:
  - `[[bob]]`
  - source context blocks used for drafting
4. User edits/approves; send happens outside this block model (draft-first policy).

Important boundary:
- Draft is a new block, never an edit of the original notes.

### Intent Inference + Clarification + Muavin Work Note

This is the intended runtime behavior for ambiguous natural language input like "email bob":

1. User/source block arrives (from notes, reminders, Telegram, etc.).
2. Muavin infers:
  - target entity candidate(s) (`[[bob]]` or likely matches)
  - action candidate (`email`)
  - whether this is actionable vs informational
3. If uncertainty is high, Muavin asks a clarification question via Telegram.
4. Once confident, Muavin creates a linked **work note** in Muavin's internal layer.
5. Dashboard/CRM views are projections over these work notes + source clusters.

#### Why this fits the block model

- Input stays freeform and source-native.
- No requirement that reminders/notes are perfectly tagged up front.
- Machine interpretation is explicit and traceable via linked work-note blocks.

#### Minimal work-note contract (internal Muavin block)

The work note should store only a small deterministic core:
- `source_block_refs` (which human/source blocks triggered this)
- `target_ref` (resolved person/entity block, e.g. `[[bob]]`)
- `action_label` (e.g. `email`)
- `state` (`needs_clarification`, `queued`, `draft_ready`, `done`, etc.)
- `confidence`
- `explanation`
- optional `draft_ref` (link to generated draft block)

This makes CRM/dashboard reliable while preserving first-principles block capture.

### Muavin-Created Block Types (minimal v1)

Assumption:
- Human/source input is always block-first and freeform.
- Muavin creates additional blocks for execution, tracking, and outputs.

Minimal Muavin-generated types to cover v1:

1. `work_item`
- Tracks actionable interpretation of user/source input.
- Core fields: target refs, action label, state, confidence, explanation, due/schedule.

2. `clarification`
- Question Muavin asks when intent/entity/action is ambiguous.
- Linked to pending `work_item`.

3. `draft`
- Candidate outbound text (email/message/note section), never auto-sent by default.
- Linked to source blocks and target entity/topic blocks.

4. `research_note`
- Muavin-generated synthesis from web/docs/user notes for "research X" flows.
- Linked to prompt/source context blocks.

5. `cannot_execute`
- Explicit marker for reminders Muavin cannot do directly (example: "read book").
- Can still spawn supporting artifacts (plan/checklist/reminders).

6. `job`
- Recurring or rule-based instruction ("nightly thesis critique", "draft reply when email type X arrives").
- Stores trigger condition and desired output behavior.

7. `job_run`
- Each concrete execution of a `job` with status, outputs, errors.
- Enables observability and debugging.

8. `insight`
- Candidate improvement/critique/reference suggestion surfaced from analysis jobs.
- Can be promoted to `work_item` if user accepts.

### Mapping your requested flows to block types

1. CRM email task ("email bob", pull Bob context)
- `work_item` -> optionally `clarification` -> `draft`

2. Misc reminder Muavin can do ("research x and pull into notes")
- `work_item` -> `research_note` (+ optional `insight` blocks)

3. Misc reminder Muavin cannot do ("read book")
- `work_item` + `cannot_execute` (+ optional structured plan as note/draft)

4. Repetitive job on notes (nightly thesis references/critiques/improvements)
- `job` -> recurring `job_run` -> `insight` (+ optional `work_item`)

5. Repetitive job on CRM (email of kind X -> draft reply)
- `job` (event trigger) -> `job_run` -> `draft` (+ optional `work_item` for review)

### Candidate additional v1 flows to accept/reject

1. Meeting prep pack
- Trigger: upcoming event linked to person/topic blocks.
- Output: `research_note` brief + optional `draft` agenda.

2. Relationship ping suggestions
- Trigger: stale contact windows by derived CRM timelines.
- Output: `work_item` + `draft` opener.

3. Weekly thesis digest
- Trigger: scheduled weekly job over thesis-tagged blocks.
- Output: `research_note` summary + top `insight` items.

4. Contradiction detector on core claims
- Trigger: new block linked to an existing thesis claim cluster.
- Output: `insight` with supporting/contradicting references.

5. Inbox triage (reminders/messages)
- Trigger: new incoming block.
- Output: `work_item` classification + state suggestion (`todo`, `waiting`, `someday`).

6. Follow-up tracker for sent drafts
- Trigger: elapsed time after draft marked sent.
- Output: `work_item` reminder to follow up.

### Writing Interface (TUI-first) — v1 shape

Goal:
- Fast writing for thesis + personal notes with Muavin "next to you," not replacing your writing flow.

Minimal TUI layout:
1. `Editor pane` (primary)
- Plain text block editing, fast capture, keyboard-first.

2. `Context pane` (right side)
- Backlinks / related blocks for current block.
- Shows both explicit links and AI-suggested related blocks.

3. `Muavin action pane` (bottom/right)
- Quick commands: draft, summarize, critique, find references, create task.
- Clarification prompts and responses (Telegram-linked if async).

4. `Work queue pane` (toggle)
- Active `work_item` / `job_run` states for current note/topic.

This keeps the note-taking surface simple while exposing execution context.

### Linking Strategy: Explicit Links vs Vector-Inferred Backlinks

Question:
- Can vector semantics replace explicit links/backlinks entirely?

#### Option A: Explicit links only

Pros:
- Deterministic graph.
- High precision for user-intended relationships.
- Stable over time (model/index changes do not alter link graph).

Cons:
- Requires manual effort.
- Misses useful implicit relationships unless user links them.

#### Option B: Vector-inferred backlinks only

Pros:
- Zero manual linking burden.
- Good discovery for semantically related content.

Cons:
- Non-deterministic retrieval behavior (index/model dependent).
- Worse on exact-name, exact-phrase, and short-note intent matching.
- Harder to audit why a relation appeared/disappeared over time.
- Can flood UI with weak/false-positive "related" links.

#### Option C (recommended): Dual graph

1. `Explicit graph` (source of truth)
- User-created links/references/backlinks.

2. `Inferred graph` (suggestion layer)
- Vector/hybrid retrieval proposes candidate links with confidence.
- User can accept/promote suggestions to explicit links.

3. Retrieval policy
- For execution-critical workflows (CRM tasks, drafting, jobs), prioritize explicit links + metadata filters.
- Use vector layer for expansion/discovery/ranking, not sole truth.

### Expected degradation if using vector-only backlinks for everything

High-level expectation:
- Works acceptably for broad thematic discovery.
- Degrades materially for action execution and entity-specific workflows.

Where degradation is most visible:
1. Person-specific CRM actions (`email bob`)
- Name ambiguity and sparse context can miss or mis-rank the right "Bob" cluster.

2. Short reminders
- Very short text has weak semantic signal; intent/entity extraction becomes noisy.

3. Reproducibility
- ANN/index parameter changes can alter nearest-neighbor sets.

Operational conclusion:
- Vector-only backlinks are viable as assistant suggestions.
- They are not a strong sole foundation for deterministic workflow automation in Muavin 1.0.

### Two modes of operation:
1. **Passive**: Muavin watches sources, extracts information, stores in memory, surfaces insights
2. **Active**: Deniz works live with muavin — thinking partner, writing collaborator, action planner

Active mode is just a more interactive version of the same pipeline — Deniz inputs thoughts, muavin processes in real-time instead of background.

## Design Principles

- **Single system**: No personal/professional split. Everything in one place.
- **Private by default**: The critical boundary is what becomes **public**, not what goes in.
- **Drafts only**: Muavin never auto-sends anything.
- **AI never edits human text**: Muavin's thoughts live separately from Deniz's writing.
- **Simple first**: Start minimal, add sources incrementally.
- **Lifelong DB**: All inputs stored durably — this is a record of Deniz's entire life over time.

## Input Layer

All inputs collapse into 4 processing patterns:

| Pattern | Sources | Processing |
|---|---|---|
| **Files in a folder** | Notability PDFs, audio, mix-assistant docs | OCR / transcribe → extract |
| **Text written by Deniz** | Notes (Logseq/Obsidian/future custom app), drafts | Parse → extract |
| **Messages from others** | Email (iCloud + Gmail), Telegram, other inboxes | Already text → extract |
| **Structured items** | Apple Reminders, calendar events | Already structured → ingest |

### Processing: "Extract" always means:
- People mentioned → CRM
- Action items → task list
- Ideas / key concepts → knowledge graph
- Decisions made → decision log
- Open questions → backlog
- Source metadata preserved (where it came from, when, context)

### Input app (future)
- Could replace or complement Logseq/Obsidian
- Similar to project_echo's logs-first approach but integrated into muavin
- On the horizon, not 1.0 launch

### Notability specifics
- Exports PDFs + audio to iCloud (auto when connected)
- Muavin watches the local iCloud sync folder
- OCR for handwritten PDFs, transcription for audio

## Memory Layer (Supabase)

- Unified vector store — all sources in one place
- Raw content preserved (lifelong DB goal)
- Extracted entities (people, actions, ideas) as structured data
- No personal/professional schema split
- Possible `sensitivity` or `visibility` field for publish-gate support

## Output Layer

From memory, muavin produces:

1. **Action prioritization** — "here's what you should focus on based on everything coming in"
2. **Drafts** — emails, messages (never auto-sent)
3. **Surfaced connections** — "you mentioned X in notes, Y just emailed about the same thing"
4. **Published content** — explicit gate, notes → website pipeline
5. **Summaries / reports** — periodic digests of what's happening

### Muavin's own thoughts
- Must be clearly separated from Deniz's written content
- Leading idea: `life/.muavin/` folder — muavin's layer lives inside the same tree, namespaced, cross-links via relative paths
- Alternative: muavin's analysis lives only in Supabase/dashboard
- Key constraint: never modify human-written text
- Some files may be "shared access" — collaborative artifacts both can edit

### Writing support (active mode)
- Deniz writes freely, then invokes muavin on a specific note/topic
- Chat-based interaction: "find references for this claim", "what are counter-arguments?"
- Muavin reads the current context, searches knowledge base + does research
- First use case: thesis/startup thinking (unifying thesis-sdm, life/logseq, mix-assistant)

## Topics Still To Discuss

- [ ] Finalize typed-note entity model and schema boundaries
- [ ] CRM & contacts schema
- [ ] Reminders → action pipeline
- [ ] Email watching details
- [ ] Writing support model (thesis/startup)
- [ ] Notes → website publishing pipeline
- [ ] Dashboard requirements
- [ ] Codex / coding integration
- [ ] Muavin's annotation model (how AI adds thoughts without touching human text)
- [ ] Prioritization engine (how actions get ranked)
- [ ] Storage / backup strategy (beyond iCloud)
- [ ] Custom input app scope

## OpenClaw-Inspired Input (Session 3 Research)

Research sources reviewed:
- GitHub issue chain: `#53` -> `#85`, `#83`
- Video transcript: "OpenClaw Use Cases that are actually helpful..." (2026-02-11)
- Prompt gist with 11 workflow specs

Most relevant architecture-level takeaways for Muavin 1.0:
- Build around reusable workflow primitives, not one-off automations.
- Strong ingestion + normalization + dedupe layers unlock many downstream use cases.
- Cost/usage tracking should be first-class early (not post hoc).
- Session/channel isolation matters for privacy and context quality.
- Backup/restore and operational reliability are part of product value, not just infra chores.

## Implementation Priority (TBD)

Start simple — possibly just:
1. Watch a folder of markdown notes
2. Extract actions + people + ideas into Supabase
3. Surface prioritized actions via Telegram
4. Add more sources incrementally

### TUI-First Writing Interface + Nesting Decision (Session 12 Follow-up)

The v1 writing surface should stay intentionally low friction:

1. launch to an empty buffer by day or note workspace
2. write freely as sequential blocks
3. keep nesting optional and low-friction (indent for readability, not ontology)
4. invoke Muavin actions from current block or selected context

Recommended baseline UX:

1. note editor pane
- freeform block input with minimal formatting and fast keyboard movement
2. context pane
- recent backlinks, linked entity blocks, and unresolved clarification queue
3. action pane
- typed commands (`/draft`, `/summarize`, `/to-do`, `/ask`, `/review`)
4. work pane
- current `work_item`, `job_run`, `clarification` items connected to visible source blocks

### Should blocks have a required structural parent?

Decision for now:
- do not model hierarchy as a mandatory first-class schema field
- do model hierarchy intent as edges (for example `contains`, `part_of`)
- compute nested UI from edge semantics when useful
- treat hard parent_id/path as derived materialization only if performance needs force it

Why this preserves flexibility:
- avoids early overfitting into a single ontology
- keeps "everything is a block" semantics intact
- keeps deterministic behavior for execution flows (jobs/crm/email drafting) based on explicit edges
- lets users still get nested mental models similar to Tana/Logseq/Roam through UI structure

Trade-offs with non-structural nesting:
- tree-like traversals may need an additional recursive edge query path
- drag-and-drop reparenting is an application feature, not a DB guarantee
- nested rendering may feel less stable until the renderer standardizes

Given the above, nesting is considered a **UI/edge layer**, not a hard substrate primitive in 1.0.

### Bullet Granularity for Outliner UX

User question:
- should a thesis outline like nested bullets be one block or many blocks?
- example: a section with nested ideas and drag/drop reordering

Recommendation:
- store one block per bullet/list item (not one monolithic outline block).
- keep indentation as block metadata/edge (`indent_level`) for rendering order.
- create explicit `contains`/`follows` edges for hierarchy and ordering.

Why this is the best v1 compromise:
1. action extraction stays precise on a per-idea granularity
2. references can target a single idea without dragging whole section context
3. moving/reordering in TUI becomes an explicit operation (`follows` + `contains` update)
4. dedupe and conflict resolution are better when units are smaller
5. supports "one buffer typing" by batching parsing and committing block graph after edit

How to preserve the "single outline feel" in editor:
- keep a local outliner mode where multiple bullets are edited in a contiguous visual block
- flatten on commit into discrete blocks behind the scenes
- avoid making monolithic blocks the default persisted unit, even if UI input feels unified

So: yes to indent/reveal/move in the interface, but no for core persistence. The data substrate still stays "block as smallest useful unit."

### Input Shape Tradeoff: Delimiter Blocks vs Bullet Blocks

Two practical serialization styles are being compared for v1 writing model.

#### Style A: Delimiter blocks with embedded outline text

Example:
- `random thought`
- `---`
- `outline`
  - `- section 1`
  - `- idea 1`

This is chunk-based and simple:
- each `---` boundary marks one stored block
- any nested indentation is text inside that block

Pros:
1. easiest capture from linear text
2. lowest schema friction
3. minimal parsing for early MVP

Cons for Muavin workflows:
1. coarse extraction and hard target selection for sub-ideas
2. references are often ambiguous (`idea 1` is not always first-class)
3. harder deterministic reordering/provenance at nested granularity
4. harder to map precise context for CRM and action runs

#### Style B: Bullet-per-item blocks with explicit hierarchy edges

Example:
- `- random thought`
- `- outline`
  - `- section 1`
    - `- idea 1`

This keeps one block per list item:
- each bullet is a persisted unit
- hierarchy expressed through `contains`/`follows` edges
- order/indent preserved by edge metadata

Pros for Muavin workflows:
1. high precision for linking, entity surface, and action targeting
2. better deterministic behavior for jobs/jobs-to-action mapping
3. stable updates/reorders and easier undo/history
4. cleaner CRM and draft context when intent is ambiguous

Cons:
1. parser is more sophisticated
2. need outliner UX discipline to prevent user fragmentation

### V1 Recommendation

Given Muavin 1.0 goals (free capture + reliable downstream action), choose **Style B as canonical storage** and treat Style A as lenient input that is normalized where practical.

- Persist one block per bullet/item for stable graph semantics.
- Preserve user flow by grouping contiguous lines in the editor as one visual session.
- Convert delimiters or raw text regions into explicit block nodes when possible.
- Keep `indent_level` optional; derive rendering from parent-like edges when needed.

### Writing Modes vs Structural Stability (Session 16)

User tension captured:
- one input stream for misc notes and reminders
- another flow for longer, stable documents (thesis/essays/code-adjacent writing)
- ability to feel both lightweight and durable

Advice direction:
1. Treat "blocks" as a universal storage primitive, but add a durable container object for stable work.
2. Use two working modes with different auto-semantics, not different schemas.
3. Keep parser behavior adaptive instead of global:
   - quick mode: low-friction chunking, fewer structural commitments
   - document mode: stricter block graph, richer section/block boundaries

Proposed v1 structure for hybrid:
1. `note_container` block
- one or more containers per workspace/context (`/day/YYYY/MM/DD`, `/projects/thesis`, `/projects/mix-assistant`)
- serves as stable parent for long-form work
- can be pinned/published, while still being the same block graph underneath

2. `leaf_block` blocks inside container
- every bullet, paragraph, and sentence-level idea can still become atomic blocks when needed
- preserves graph actionability for CRM, drafting, jobs

3. `content_profile` flag at container level
- `scratch`: parser favors fast entry and minimal nesting commitments
- `document`: parser favors headings, sections, ordered structure, and stable section identities

Practical recommendation for your exact question:
- Thesis mode should default to `document` container.
- Daily random notes should default to `scratch` container.
- both can reuse the same block/edge engine.

Tradeoffs for this pattern:
1. no need to choose one of two incompatible data models
2. still supports “mythic outliner” ergonomics where useful
3. allows long-form markdown/latex in dedicated containers without blocking fast notes
4. avoids overfitting to one app model (Logseq vs Obsidian)
5. adds one layer of complexity: container-level mode handling and migration paths

Open questions moved to tomorrow:
- default mode for new sessions?
- whether document mode should auto-insert section-level IDs
- when to auto-promote scratch text into document container
- how to expose this in TUI without adding friction (one key toggle vs automatic detection)

### Blocks as Content Chunks + Render Profiles (Session 17)

User direction:
- consider treating every block as a content chunk (line/paragraph/doc fragment), even in long-form drafts.
- a "document" then becomes a sequence of block chunks with a chosen render profile (paragraph view, outline view, etc.).
- nesting should be retained for proper rendering and editing behavior, not discarded.

Working interpretation:
- keep storage as `blocks` as unit of content chunking.
- keep `edges` (or metadata edges) to encode sequence, containment, or heading semantics.
- render profile is an orthogonal layer, allowing:
  - paragraph mode
  - outline mode
  - markdown mode
  - latex mode

Reframed principle:
- atomicity is now about *content chunking + references*, not about user-facing shape.
- the same block set can render as daily bullets or as stable thesis draft sections depending on container/profile.

Trade-off to resolve:
1. richer nesting metadata increases parser and migration complexity
2. if nesting is only implicit in rendering, deterministic reorder operations are harder
3. explicit nesting edges improve edit-history correctness for long-form rearrangement
4. if every chunk has lightweight `rendering_intent` + explicit `contains`/`next_sibling` edges, you can satisfy both ergonomics and determinism

Practical lean for v1:
- parse and persist chunk blocks with minimal required edges now.
- add optional explicit nesting/ordering metadata when leaving scratch mode for stable docs.
