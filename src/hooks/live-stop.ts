import "../env";
import { readFile, unlink } from "fs/promises";
import { createMuaBlock, insertLink } from "../blocks";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk as Buffer);
}

const raw = Buffer.concat(chunks).toString("utf-8").trim();
let transcriptPath: string | undefined;
let sessionId: string | undefined;
try {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  transcriptPath = typeof parsed["transcript_path"] === "string" ? parsed["transcript_path"] : undefined;
  sessionId = typeof parsed["session_id"] === "string" ? parsed["session_id"] : undefined;
} catch {
  process.exit(0);
}

if (!transcriptPath) process.exit(0);

const STATE_FILE = "/tmp/muavin-live-session-state.json";

interface SessionState {
  session_id: string;
  turn: number;
  turns: Array<{ turn: number; user_block_id: string }>;
}

async function readState(): Promise<SessionState | null> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

let transcriptRaw: string;
try {
  transcriptRaw = await readFile(transcriptPath, "utf-8");
} catch {
  process.exit(0);
}

interface TranscriptEntry {
  type: string;
  isMeta?: boolean;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; thinking?: string }>;
  };
}

// Parse JSONL transcript
const entries: TranscriptEntry[] = [];
for (const line of transcriptRaw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    entries.push(JSON.parse(trimmed) as TranscriptEntry);
  } catch {
    // skip malformed lines
  }
}

// Extract real conversational turns (non-meta, non-tool-result user messages and assistant messages)
// A "real user message" is type=user, not isMeta, and content is a plain string (not tool_result array)
function isToolResultContent(content: string | Array<{ type: string; text?: string; thinking?: string }>): boolean {
  if (Array.isArray(content)) {
    return content.some((c) => "tool_use_id" in c || c.type === "tool_result");
  }
  return false;
}

function extractTextFromContent(content: string | Array<{ type: string; text?: string; thinking?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

function isToolUseContent(content: string | Array<{ type: string; text?: string; thinking?: string }>): boolean {
  if (Array.isArray(content)) {
    return content.every((c) => c.type === "tool_use" || c.type === "thinking");
  }
  return false;
}

// Build list of (userTurn, assistantText) pairs by walking the entries
// We track conversational turns: each real user message starts a turn, followed by assistant messages
// Multiple assistant entries may belong to the same turn (streaming chunks or tool-use steps)
interface ConversationTurn {
  userTurn: number; // 1-based turn index matching state.turns
  assistantText: string;
}

const conversationTurns: ConversationTurn[] = [];
let currentUserTurn = 0;
let pendingAssistantTexts: string[] = [];

function flushAssistant(): void {
  const text = pendingAssistantTexts.filter((t) => t.trim()).join("\n").trim();
  if (text && currentUserTurn > 0) {
    conversationTurns.push({ userTurn: currentUserTurn, assistantText: text });
  }
  pendingAssistantTexts = [];
}

for (const entry of entries) {
  if (entry.type === "user" && !entry.isMeta && entry.message) {
    const content = entry.message.content;
    if (!isToolResultContent(content)) {
      // Real user message — flush pending assistant, start new turn
      flushAssistant();
      currentUserTurn++;
    }
  } else if (entry.type === "assistant" && entry.message) {
    const content = entry.message.content;
    if (!isToolUseContent(content)) {
      const text = extractTextFromContent(content);
      if (text.trim()) pendingAssistantTexts.push(text);
    }
  }
}
flushAssistant();

if (conversationTurns.length === 0) process.exit(0);

const state = await readState();
const sid = sessionId ?? state?.session_id ?? "unknown";

// Create mua_blocks and link them to user_blocks
for (const { userTurn, assistantText } of conversationTurns) {
  let muaBlockId: string;
  try {
    const result = await createMuaBlock({
      content: assistantText,
      source: "live",
      sourceRef: { type: "live_session", id: { session_id: sid, turn: userTurn } },
      metadata: { trigger: "stop_hook" },
      blockKind: "note",
    });
    muaBlockId = result.id;
  } catch (err: unknown) {
    console.error("[live-stop] createMuaBlock error:", err);
    continue;
  }

  // Link: mua_block derived_from the user_block that prompted it
  if (state) {
    const turnEntry = state.turns.find((t) => t.turn === userTurn);
    if (turnEntry) {
      await insertLink({
        fromType: "mua_block",
        fromId: muaBlockId,
        toType: "user_block",
        toId: turnEntry.user_block_id,
        linkType: "derived_from",
      }).catch((err: unknown) => {
        console.error("[live-stop] insertLink derived_from error:", err);
      });

      // Link: next user_block is related to this mua_block (user is responding to assistant)
      const nextTurnEntry = state.turns.find((t) => t.turn === userTurn + 1);
      if (nextTurnEntry) {
        await insertLink({
          fromType: "user_block",
          fromId: nextTurnEntry.user_block_id,
          toType: "mua_block",
          toId: muaBlockId,
          linkType: "related",
        }).catch((err: unknown) => {
          console.error("[live-stop] insertLink related error:", err);
        });
      }
    }
  }
}

// Clean up state file
await unlink(STATE_FILE).catch(() => {});

process.exit(0);
