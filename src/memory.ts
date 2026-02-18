import { createClient } from "@supabase/supabase-js";
import { readFile, mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { callClaude } from "./claude";
import { sendAndLog } from "./telegram";
import { MUAVIN_DIR, loadConfig } from "./utils";
import { EMBEDDING_DIMS, EMBEDDING_MODEL, EMBEDDING_TIMEOUT_MS } from "./constants";

const SYSTEM_CWD = join(MUAVIN_DIR, "system");
const PROMPTS_DIR = join(MUAVIN_DIR, "prompts");

const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          content: { type: "string" }
        },
        required: ["type", "content"],
        additionalProperties: false
      }
    }
  },
  required: ["memories"],
  additionalProperties: false
};

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
  {
    global: {
      fetch: ((url: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("Connection", "close");
        return fetch(url, { ...init, keepalive: false, headers } as RequestInit);
      }) as typeof fetch,
    },
  },
);

export async function embed(text: string): Promise<number[]> {
  // Raw fetch: OpenAI SDK v4.104.0 corrupts dimensions param on Bun
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    keepalive: false,
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Connection": "close",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIMS }),
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
  } as RequestInit);
  if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

export async function logMessage(
  role: "user" | "assistant",
  content: string,
  chatId: string,
): Promise<void> {
  const embedding = await embed(content);
  const { error } = await supabase.from("messages").insert({
    role,
    content,
    chat_id: chatId,
    embedding,
  });
  if (error) throw new Error(`logMessage insert failed: ${error.message}`);
}

async function searchRpc(
  rpcName: string,
  queryEmbedding: number[],
  threshold: number,
  limit: number,
  abortSignal?: AbortSignal,
): Promise<Array<{ content: string; source: string; similarity: number }>> {
  let query = supabase.rpc(rpcName, {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: limit,
  });
  if (abortSignal) query = query.abortSignal(abortSignal);
  const { data, error } = await query;
  if (error) {
    console.error(`${rpcName} error:`, error);
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
  abortSignal?: AbortSignal,
): Promise<Array<{ content: string; source: string; similarity: number }>> {
  const queryEmbedding = await embed(query);

  const [memoryResults, messageResults] = await Promise.all([
    searchRpc("search_memory", queryEmbedding, 0.7, limit, abortSignal),
    searchRpc("search_messages", queryEmbedding, 0.75, limit, abortSignal),
  ]);

  if (isGoodEnough(memoryResults, limit)) {
    return memoryResults;
  }

  const merged = [...memoryResults, ...messageResults]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
  return merged;
}

export async function extractMemories(model?: string): Promise<number> {
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
        maxTurns: 3,
        timeoutMs: 300000,
        model,
        jsonSchema: MEMORY_SCHEMA,
      });

      // Mark as processed immediately (even if parsing fails)
      processedIds.push(...msgs.map(m => m.id));

      let parsed: { memories: Array<{ type: string; content: string }> };
      if (result.structuredOutput) {
        parsed = result.structuredOutput as { memories: Array<{ type: string; content: string }> };
      } else {
        try {
          parsed = JSON.parse(extractJSON(result.text));
        } catch {
          console.error("extractMemories: failed to parse text response for chat", chatId, "— text:", result.text.slice(0, 200));
          continue;
        }
      }

      const facts = parsed.memories;

      if (!Array.isArray(facts)) continue;

      for (const fact of facts) {
        // Check for near-duplicates
        try {
          const factEmbedding = await embed(fact.content);
          const dupes = await searchRpc("search_memory", factEmbedding, 0.92, 1);
          if (dupes.length > 0) continue;

          const { error: insertError } = await supabase.from("memory").insert({
            type: fact.type,
            content: fact.content,
            source: "extraction",
            embedding: factEmbedding,
            source_chat_id: chatId,
            source_date: msgs[0].created_at,
          });
          if (insertError) {
            console.error("extractMemories: insert failed:", insertError);
          } else {
            extracted++;
          }
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
  abortSignal?: AbortSignal,
): Promise<Array<{ role: string; content: string; created_at: string }>> {
  let query = supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (abortSignal) query = query.abortSignal(abortSignal);
  const { data, error } = await query;

  if (error || !data) return [];
  return data.reverse();
}

export async function getAssistantMessages(
  chatId: string,
  limit: number,
  abortSignal?: AbortSignal,
): Promise<Array<{ content: string; created_at: string }>> {
  let query = supabase
    .from("messages")
    .select("content, created_at")
    .eq("chat_id", chatId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (abortSignal) query = query.abortSignal(abortSignal);
  const { data, error } = await query;
  if (error || !data) return [];
  return data.reverse();
}

interface HealthCheckResult {
  stale: number[];
  clarify: Array<{ id: number; question: string }>;
  merge: Array<{ ids: number[]; merged: string }>;
  resolved: Array<{ stale_id: number; kept_id: number; reason: string }>;
}

export async function runHealthCheck(model?: string): Promise<void> {
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
    model,
  });
  let healthResult: HealthCheckResult;

  try {
    healthResult = JSON.parse(extractJSON(result.text));
  } catch {
    console.error("Failed to parse health check result, response:", result.text.slice(0, 200));
    return;
  }

  // Validate structure
  const validMemoryIds = new Set(memories.map(m => m.id));

  function isValidStructure(obj: any): obj is HealthCheckResult {
    return (
      obj &&
      typeof obj === "object" &&
      Array.isArray(obj.stale) &&
      Array.isArray(obj.clarify) &&
      Array.isArray(obj.merge) &&
      Array.isArray(obj.resolved)
    );
  }

  if (!isValidStructure(healthResult)) {
    console.error("Health check result has invalid structure:", Object.keys(healthResult));
    return;
  }

  // Filter and validate IDs
  const originalCounts = {
    stale: healthResult.stale.length,
    clarify: healthResult.clarify.length,
    merge: healthResult.merge.length,
    resolved: healthResult.resolved.length,
  };

  healthResult.stale = healthResult.stale.filter(id => validMemoryIds.has(id));
  healthResult.clarify = healthResult.clarify.filter(item => validMemoryIds.has(item.id));
  healthResult.merge = healthResult.merge.filter(item => item.ids.every(id => validMemoryIds.has(id)));
  healthResult.resolved = healthResult.resolved.filter(item =>
    validMemoryIds.has(item.stale_id) && validMemoryIds.has(item.kept_id)
  );

  // Log filtered entries
  const filteredCounts = {
    stale: originalCounts.stale - healthResult.stale.length,
    clarify: originalCounts.clarify - healthResult.clarify.length,
    merge: originalCounts.merge - healthResult.merge.length,
    resolved: originalCounts.resolved - healthResult.resolved.length,
  };

  const totalFiltered = Object.values(filteredCounts).reduce((a, b) => a + b, 0);
  if (totalFiltered > 0) {
    console.warn(`Health check: filtered ${totalFiltered} entries with invalid IDs:`, filteredCounts);
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
      await sendAndLog(config.owner, message);
    }
    console.log(`Sent ${healthResult.clarify.length} clarification requests`);
  }

  // Process merges
  if (healthResult.merge && healthResult.merge.length > 0) {
    for (const item of healthResult.merge) {
      // Insert merged entry
      const embedding = await embed(item.merged).catch((e) => { console.error("health check merge embed failed:", e); return null; });
      const { error: mergeInsertError } = await supabase.from("memory").insert({
        type: "personal_fact",
        content: item.merged,
        source: "health_check_merge",
        embedding,
      });

      if (mergeInsertError) {
        console.error("health check merge insert failed, skipping stale marking:", mergeInsertError);
        continue;
      }

      // Mark originals as stale
      await supabase
        .from("memory")
        .update({ stale: true })
        .in("id", item.ids);
    }
    console.log(`Merged ${healthResult.merge.length} memory groups`);
  }
}

