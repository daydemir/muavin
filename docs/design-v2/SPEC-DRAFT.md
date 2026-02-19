# Muavin v2: Design Spec (Draft)

Status: In progress — working through topics with Deniz.

## Core Concept

Muavin is a **personal chief of staff** — a unified ingestion + synthesis system that pulls in everything Deniz is thinking and experiencing, stores it as a lifelong database, and helps produce outputs (actions, drafts, published content, connections).

## High-Level Architecture

```
INPUTS → EXTRACT → MEMORY (Supabase) → SURFACE / PRODUCE → OUTPUTS
```

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
- On the horizon, not v2 launch

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
- TBD: companion files? Margin annotations? Separate "muavin notes" section?
- Key constraint: never modify human-written text

## Topics Still To Discuss

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

## Implementation Priority (TBD)

Start simple — possibly just:
1. Watch a folder of markdown notes
2. Extract actions + people + ideas into Supabase
3. Surface prioritized actions via Telegram
4. Add more sources incrementally
