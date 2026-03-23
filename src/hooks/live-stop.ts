import "../env";
import { readFile } from "fs/promises";
import { createMuaBlock } from "../blocks";

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

let transcriptRaw: string;
try {
  transcriptRaw = await readFile(transcriptPath, "utf-8");
} catch {
  process.exit(0);
}

interface TranscriptMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

let messages: TranscriptMessage[] = [];
try {
  const parsed = JSON.parse(transcriptRaw) as unknown;
  if (Array.isArray(parsed)) {
    messages = parsed as TranscriptMessage[];
  }
} catch {
  process.exit(0);
}

const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
if (!lastAssistant) process.exit(0);

let content: string;
if (typeof lastAssistant.content === "string") {
  content = lastAssistant.content;
} else if (Array.isArray(lastAssistant.content)) {
  content = lastAssistant.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
} else {
  process.exit(0);
}

if (!content.trim()) process.exit(0);

try {
  await createMuaBlock({
    content,
    source: "live",
    sourceRef: { type: "live_session", id: { session_id: sessionId ?? null } },
    metadata: { trigger: "stop_hook" },
    blockKind: "note",
  });
} catch (err: unknown) {
  console.error("[live-stop] createMuaBlock error:", err);
}

process.exit(0);
