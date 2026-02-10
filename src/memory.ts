import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { callClaude } from "./claude";

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const MUAVIN_DIR = join(process.env.HOME ?? "~", ".muavin");
const CRON_STATE_PATH = join(MUAVIN_DIR, "cron-state.json");
const CONFIG_PATH = join(MUAVIN_DIR, "config.json");

interface CronState {
  memory_md_hash?: string;
  [key: string]: unknown;
}

interface Config {
  owner: number;
  [key: string]: unknown;
}

async function loadCronState(): Promise<CronState> {
  try {
    const content = await readFile(CRON_STATE_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveCronState(state: CronState): Promise<void> {
  await mkdir(MUAVIN_DIR, { recursive: true });
  await writeFile(CRON_STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadConfig(): Promise<Config> {
  const content = await readFile(CONFIG_PATH, "utf-8");
  return JSON.parse(content);
}

async function sendTelegram(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function embed(text: string): Promise<number[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
      });
      return res.data[0].embedding;
    } catch (e) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      console.error(`embed failed after 3 attempts: "${text.slice(0, 80)}..."`, e);
      throw e;
    }
  }
  throw new Error("unreachable");
}

export async function logMessage(
  role: "user" | "assistant",
  content: string,
  chatId: string,
): Promise<void> {
  const embedding = await embed(content).catch(e => {
    console.error("logMessage embed failed, storing without embedding:", e);
    return null;
  });
  const { error } = await supabase.from("messages").insert({
    role,
    content,
    chat_id: chatId,
    embedding,
  });
  if (error) console.error("logMessage insert failed:", error);
}

async function searchMemoryOnly(
  queryEmbedding: number[],
  threshold: number,
  limit: number,
): Promise<Array<{ content: string; source: string; similarity: number }>> {
  const { data, error } = await supabase.rpc("search_memory", {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: limit,
  });
  if (error) {
    console.error("searchMemoryOnly error:", error);
    return [];
  }
  return data ?? [];
}

async function searchMessagesOnly(
  queryEmbedding: number[],
  threshold: number,
  limit: number,
): Promise<Array<{ content: string; source: string; similarity: number }>> {
  const { data, error } = await supabase.rpc("search_messages", {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: limit,
  });
  if (error) {
    console.error("searchMessagesOnly error:", error);
    return [];
  }
  return data ?? [];
}

function isGoodEnough(
  results: Array<{ similarity: number }>,
  requested: number,
): boolean {
  if (results.length === 0) return false;
  const top = results[0].similarity;
  if (top >= 0.82) return true;
  if (top >= 0.75 && results.length >= Math.ceil(requested / 2)) return true;
  return false;
}

export async function searchContext(
  query: string,
  limit = 5,
): Promise<Array<{ content: string; source: string; similarity: number }>> {
  const queryEmbedding = await embed(query);
  const memoryResults = await searchMemoryOnly(queryEmbedding, 0.7, limit);

  if (isGoodEnough(memoryResults, limit)) {
    return memoryResults;
  }

  const messageResults = await searchMessagesOnly(queryEmbedding, 0.75, limit);
  const merged = [...memoryResults, ...messageResults]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
  return merged;
}

export async function extractMemories(): Promise<number> {
  const { data: messages, error } = await supabase
    .from("messages")
    .select("id, role, content, chat_id, created_at")
    .is("extracted_at", null)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error || !messages || messages.length === 0) return 0;

  // Group by chat_id
  const chunks: Record<string, typeof messages> = {};
  for (const msg of messages) {
    if (!chunks[msg.chat_id]) chunks[msg.chat_id] = [];
    chunks[msg.chat_id].push(msg);
  }

  let extracted = 0;
  const allMessageIds = messages.map(m => m.id);

  try {
    for (const [chatId, msgs] of Object.entries(chunks)) {
      const conversation = msgs
        .map(m => `${m.role}: ${m.content}`)
        .join("\n");

      const result = await callClaude(
        `Extract personal facts, preferences, goals, relationships from this conversation.
Only extract things worth remembering long-term.
Output JSON: [{"type": "personal_fact|preference|goal|relationship|context", "content": "..."}]
If nothing worth extracting, return [].

Conversation:
${conversation}`,
        { noSessionPersistence: true },
      );

      let facts: Array<{ type: string; content: string }>;
      try {
        facts = JSON.parse(result.text);
      } catch {
        console.error("extractMemories: failed to parse Claude response for chat", chatId);
        continue;
      }

      if (!Array.isArray(facts)) continue;

      for (const fact of facts) {
        // Check for near-duplicates
        try {
          const factEmbedding = await embed(fact.content);
          const dupes = await searchMemoryOnly(factEmbedding, 0.92, 1);
          if (dupes.length > 0) continue;

          await supabase.from("memory").insert({
            type: fact.type,
            content: fact.content,
            source: "extraction",
            embedding: factEmbedding,
            source_chat_id: chatId,
            source_date: msgs[0].created_at,
          });
          extracted++;
        } catch (e) {
          console.error("extractMemories: failed to process fact:", e);
        }
      }
    }
  } finally {
    // Mark all processed messages regardless of success/failure
    await supabase
      .from("messages")
      .update({ extracted_at: new Date().toISOString() })
      .in("id", allMessageIds);
  }

  return extracted;
}

async function findClaudeMemoryPath(): Promise<string | null> {
  const claudeProjectsDir = join(process.env.HOME ?? "~", ".claude", "projects");
  try {
    const dirs = await readdir(claudeProjectsDir);
    for (const dir of dirs) {
      const memoryPath = join(claudeProjectsDir, dir, "memory", "MEMORY.md");
      try {
        await readFile(memoryPath);
        return memoryPath;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function syncMemoryMd(projectDir: string): Promise<number> {
  // Phase 1: Harvest new entries from MEMORY.md
  const claudeMemoryPath = await findClaudeMemoryPath();
  const memoryPaths = [
    ...(claudeMemoryPath ? [claudeMemoryPath] : []),
    join(projectDir, "MEMORY.md"),
  ];

  let content = "";
  let memoryMdPath = "";
  for (const p of memoryPaths) {
    try {
      content = await readFile(p, "utf-8");
      memoryMdPath = p;
      break;
    } catch {
      continue;
    }
  }

  // Load cron state to check for previously regenerated content
  const cronState = await loadCronState();
  const previousHash = cronState.memory_md_hash ?? "";

  // If the file is unchanged from what we generated, skip harvest
  const currentHash = createHash("sha256").update(content).digest("hex");
  const fileWasModified = currentHash !== previousHash;

  // Parse entries: each non-empty line is an entry
  const entries = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  let synced = 0;
  if (fileWasModified) {
    for (const entry of entries) {
      const hash = createHash("sha256").update(entry).digest("hex").slice(0, 16);

      // Check if already exists by source hash
      const { data: existing } = await supabase
        .from("memory")
        .select("id")
        .eq("source", `memory_md:${hash}`)
        .limit(1);

      if (existing && existing.length > 0) continue;

      const embedding = await embed(entry).catch((e) => { console.error("syncMemoryMd embed failed:", e); return null; });
      await supabase.from("memory").insert({
        type: "personal_fact",
        content: entry,
        source: `memory_md:${hash}`,
        embedding,
      });
      synced++;
    }
  }

  // Phase 2: Regenerate MEMORY.md from Supabase
  if (memoryMdPath) {
    const { data: memories } = await supabase
      .from("memory")
      .select("type, content")
      .eq("stale", false)
      .order("created_at", { ascending: false })
      .limit(50);

    if (memories && memories.length > 0) {
      // Group by type
      const byType: Record<string, string[]> = {};
      for (const m of memories) {
        const type = m.type ?? "other";
        if (!byType[type]) byType[type] = [];
        byType[type].push(m.content);
      }

      // Generate organized content
      let regenerated = "# Muavin Memory\n\n";
      for (const [type, items] of Object.entries(byType)) {
        regenerated += `## ${type}\n`;
        for (const item of items) {
          regenerated += `${item}\n`;
        }
        regenerated += "\n";
      }

      // Save regenerated content and hash
      await writeFile(memoryMdPath, regenerated);
      const newHash = createHash("sha256").update(regenerated).digest("hex");
      cronState.memory_md_hash = newHash;
      await saveCronState(cronState);
    }
  }

  return synced;
}

interface HealthCheckResult {
  stale: number[];
  clarify: Array<{ id: number; question: string }>;
  merge: Array<{ ids: number[]; merged: string }>;
  resolved: Array<{ stale_id: number; kept_id: number; reason: string }>;
}

export async function runHealthCheck(): Promise<void> {
  // Fetch all non-stale memories
  const { data: memories } = await supabase
    .from("memory")
    .select("id, type, content, created_at")
    .eq("stale", false)
    .order("created_at", { ascending: false });

  if (!memories || memories.length === 0) {
    console.log("No memories to check");
    return;
  }

  const memoriesText = memories
    .map((m) => `[${m.id}] (${m.type}) ${m.content}`)
    .join("\n");

  const prompt = `Review these memories for a personal AI assistant. Find issues in these categories:

1. **Auto-resolvable**: Temporal updates where newer info is obviously correct (e.g. "graduating in May" → "graduated in May"). For these, identify the stale (older) entry and the one to keep.
2. **Needs user input**: Genuine contradictions or ambiguity where you can't determine which is correct. Output a clear question.
3. **Merge candidates**: Near-duplicates that should be consolidated into one entry.
4. **Stale**: Outdated information that's no longer relevant.

Memories:
${memoriesText}

Output JSON only:
{
  "resolved": [{"stale_id": id, "kept_id": id, "reason": "..."}],
  "stale": [id1, id2],
  "clarify": [{"id": id, "question": "question to ask user"}],
  "merge": [{"ids": [id1, id2], "merged": "merged text"}]
}`;

  const result = await callClaude(prompt, { noSessionPersistence: true });
  let healthResult: HealthCheckResult;

  try {
    healthResult = JSON.parse(result.text);
  } catch {
    console.error("Failed to parse health check result");
    return;
  }

  // Load config for owner chat ID
  const config = await loadConfig();

  // Process stale items
  if (healthResult.stale && healthResult.stale.length > 0) {
    await supabase
      .from("memory")
      .update({ stale: true })
      .in("id", healthResult.stale);
    console.log(`Marked ${healthResult.stale.length} memories as stale`);
  }

  // Process auto-resolved contradictions
  if (healthResult.resolved && healthResult.resolved.length > 0) {
    const staleIds = healthResult.resolved.map(r => r.stale_id);
    await supabase
      .from("memory")
      .update({ stale: true })
      .in("id", staleIds);
    for (const r of healthResult.resolved) {
      console.log(`Auto-resolved: marked ${r.stale_id} stale, kept ${r.kept_id} — ${r.reason}`);
    }
  }

  // Process clarifications
  if (healthResult.clarify && healthResult.clarify.length > 0) {
    for (const item of healthResult.clarify) {
      // Find the memory content for context
      const mem = memories.find(m => m.id === item.id);
      const message = `Memory conflict:\n${mem ? `"${mem.content}"` : `(ID: ${item.id})`}\n\n${item.question}`;
      await sendTelegram(config.owner, message);
    }
    console.log(`Sent ${healthResult.clarify.length} clarification requests`);
  }

  // Process merges
  if (healthResult.merge && healthResult.merge.length > 0) {
    for (const item of healthResult.merge) {
      // Insert merged entry
      const embedding = await embed(item.merged).catch((e) => { console.error("health check merge embed failed:", e); return null; });
      await supabase.from("memory").insert({
        type: "personal_fact",
        content: item.merged,
        source: "health_check_merge",
        embedding,
      });

      // Mark originals as stale
      await supabase
        .from("memory")
        .update({ stale: true })
        .in("id", item.ids);
    }
    console.log(`Merged ${healthResult.merge.length} memory groups`);
  }
}

// Test block — run with: bun run src/memory.ts
if (import.meta.main) {
  console.log("Testing memory system...");
  await logMessage("user", "Test message from memory.ts", "test");
  const results = await searchContext("test message");
  console.log("Search results:", results);
}
