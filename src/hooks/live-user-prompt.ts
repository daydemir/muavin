import "../env";
import { readFile, writeFile } from "fs/promises";
import { createUserBlock, searchRelatedBlocks } from "../blocks";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk as Buffer);
}

const raw = Buffer.concat(chunks).toString("utf-8").trim();
let prompt = "";
let sessionId: string | undefined;
try {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  prompt = typeof parsed["prompt"] === "string" ? parsed["prompt"] : "";
  sessionId = typeof parsed["session_id"] === "string" ? parsed["session_id"] : undefined;
} catch {
  process.exit(0);
}

if (!prompt) process.exit(0);

const STATE_FILE = "/tmp/muavin-live-session-state.json";

interface SessionState {
  session_id: string;
  turn: number;
  turns: Array<{ turn: number; user_block_id: string }>;
}

async function readState(sid: string): Promise<SessionState> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as SessionState;
    if (parsed.session_id === sid) return parsed;
  } catch {
    // no state or different session
  }
  return { session_id: sid, turn: 0, turns: [] };
}

async function writeState(state: SessionState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state), "utf-8");
}

const sid = sessionId ?? "unknown";
const state = await readState(sid);
const turn = state.turn + 1;

const skip = prompt.length < 5 || prompt.startsWith("/");

// Create user block with session/turn metadata
const userBlockPromise = createUserBlock({
  rawContent: prompt,
  source: "live",
  sourceRef: { type: "live_session", id: { session_id: sid, turn } },
  metadata: { direction: "inbound" },
}).then(async (result) => {
  const newState: SessionState = {
    session_id: sid,
    turn,
    turns: [...state.turns, { turn, user_block_id: result.id }],
  };
  await writeState(newState);
  return result;
}).catch((err: unknown) => {
  console.error("[live-user-prompt] createUserBlock error:", err);
  return null;
});

if (!skip) {
  // Run search in parallel with user block creation
  const [, results] = await Promise.all([
    userBlockPromise,
    searchRelatedBlocks({ query: prompt, scope: "all", limit: 5 }).catch((err: unknown) => {
      console.error("[live-user-prompt] searchRelatedBlocks error:", err);
      return [];
    }),
  ]);
  if (results.length > 0) {
    const lines: string[] = ["[Memory Context]"];
    for (const r of results) {
      const date = r.createdAt.slice(0, 10);
      const preview = r.content.length > 200 ? r.content.slice(0, 200) + "…" : r.content;
      lines.push("---");
      lines.push(`[${r.source}:${date}] ${preview}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  }
} else {
  await userBlockPromise;
}

process.exit(0);
