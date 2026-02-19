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

### Topics remaining:
1. CRM & Contacts
2. Reminders → CRM Pipeline
3. Email Watching
4. Writing Support
5. Notes → Website Pipeline
6. Dashboard
7. Codex / Coding Integration

Plus cross-cutting: privacy/publish gate, muavin annotation model, prioritization engine.
