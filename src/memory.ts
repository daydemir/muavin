import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { readFile, mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { callClaude } from "./claude";
import { sendTelegram } from "./telegram";
import { loadConfig } from "./utils";

const SYSTEM_CWD = join(homedir(), ".muavin", "system");
const PROMPTS_DIR = join(homedir(), ".muavin", "prompts");

function extractJSON(text: string): string {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (match) return match[1].trim();
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) return arr[0];
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) return obj[0];
  return text.trim();
}

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const MUAVIN_DIR = join(homedir(), ".muavin");

export async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return res.data[0].embedding;
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
  const processedIds: number[] = [];

  const promptTemplate = readFileSync(join(PROMPTS_DIR, "extract-memories.md"), "utf-8");

  try {
    for (const [chatId, msgs] of Object.entries(chunks)) {
      const conversation = msgs
        .map(m => `${m.role}: ${m.content}`)
        .join("\n");

      const prompt = promptTemplate.replace("{{CONVERSATION}}", conversation);

      const result = await callClaude(prompt, {
        noSessionPersistence: true,
        cwd: SYSTEM_CWD,
        maxTurns: 1,
        timeoutMs: 300000,
      });

      // Mark as processed immediately (even if parsing fails)
      processedIds.push(...msgs.map(m => m.id));

      let facts: Array<{ type: string; content: string }>;
      try {
        facts = JSON.parse(extractJSON(result.text));
      } catch {
        console.error("extractMemories: failed to parse Claude response for chat", chatId, "response:", result.text.slice(0, 200));
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
    if (processedIds.length > 0) {
      await supabase
        .from("messages")
        .update({ extracted_at: new Date().toISOString() })
        .in("id", processedIds);
    }
  }

  return extracted;
}

export async function getRecentMessages(
  chatId: string,
  limit: number,
): Promise<Array<{ role: string; content: string; created_at: string }>> {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data.reverse();
}

interface HealthCheckResult {
  stale: number[];
  clarify: Array<{ id: number; question: string }>;
  merge: Array<{ ids: number[]; merged: string }>;
  resolved: Array<{ stale_id: number; kept_id: number; reason: string }>;
}

export async function runHealthCheck(): Promise<void> {
  // Fetch all non-stale memories
  const { data: memories, error } = await supabase
    .from("memory")
    .select("id, type, content, created_at")
    .eq("stale", false)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("runHealthCheck query error:", error);
    return;
  }

  if (!memories || memories.length === 0) {
    console.log("No memories to check");
    return;
  }

  const memoriesText = memories
    .map((m) => `[${m.id}] (${m.type}) ${m.content}`)
    .join("\n");

  const promptTemplate = readFileSync(join(PROMPTS_DIR, "health-check.md"), "utf-8");
  const prompt = promptTemplate.replace("{{MEMORIES}}", memoriesText);

  const result = await callClaude(prompt, {
    noSessionPersistence: true,
    cwd: SYSTEM_CWD,
    maxTurns: 1,
    timeoutMs: 300000,
  });
  let healthResult: HealthCheckResult;

  try {
    healthResult = JSON.parse(extractJSON(result.text));
  } catch {
    console.error("Failed to parse health check result, response:", result.text.slice(0, 200));
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

