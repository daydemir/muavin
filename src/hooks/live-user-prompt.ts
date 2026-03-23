import "../env";
import { createUserBlock, searchRelatedBlocks } from "../blocks";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk as Buffer);
}

const raw = Buffer.concat(chunks).toString("utf-8").trim();
let prompt = "";
try {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  prompt = typeof parsed["prompt"] === "string" ? parsed["prompt"] : "";
} catch {
  process.exit(0);
}

if (!prompt) process.exit(0);

const skip = prompt.length < 5 || prompt.startsWith("/");

// Fire-and-forget: persist user block regardless
createUserBlock({
  rawContent: prompt,
  source: "live",
  sourceRef: { type: "live_session", id: {} },
  metadata: { direction: "inbound" },
}).catch((err: unknown) => {
  console.error("[live-user-prompt] createUserBlock error:", err);
});

if (!skip) {
  try {
    const results = await searchRelatedBlocks({ query: prompt, scope: "all", limit: 5 });
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
  } catch (err: unknown) {
    console.error("[live-user-prompt] searchRelatedBlocks error:", err);
  }
}

process.exit(0);
