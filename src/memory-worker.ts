/**
 * Short-lived subprocess for Supabase/OpenAI context calls.
 *
 * Usage:
 *   echo '{"query":"...","limit":3}' | bun run src/memory-worker.ts search
 *   echo '{"chatId":"123","limit":20}' | bun run src/memory-worker.ts recent
 */
import { validateEnv } from "./env";
validateEnv();

import { searchRelatedBlocks } from "./blocks";
import { supabase } from "./db";

const command = process.argv[2];
const input = JSON.parse(await Bun.stdin.text());

interface RecentRow {
  author_type: "user" | "mua";
  content: string;
  created_at: string;
}

async function fetchRecent(chatId: string, limit: number, assistantOnly = false) {
  let query = supabase
    .from("all_blocks_v")
    .select("author_type, content, created_at")
    .eq("source", "chat")
    .contains("source_ref", { type: "telegram_message", id: { chat_id: chatId } })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (assistantOnly) query = query.eq("author_type", "mua");

  const { data, error } = await query;
  if (error) throw new Error(`recent query failed: ${error.message}`);

  const rows = (data ?? []) as RecentRow[];
  return rows
    .reverse()
    .map((row) => ({
      role: row.author_type === "mua" ? "assistant" : "user",
      content: row.content,
      created_at: row.created_at,
    }));
}

try {
  let result: unknown;

  if (command === "search") {
    const rows = await searchRelatedBlocks({
      query: String(input.query ?? ""),
      scope: "all",
      limit: input.limit ?? 3,
    });

    result = rows.map((r) => ({
      content: r.content,
      source: `${r.authorType}:${r.source}`,
      similarity: r.score,
      author_type: r.authorType,
      created_at: r.createdAt,
    }));
  } else if (command === "recent") {
    result = await fetchRecent(String(input.chatId ?? ""), input.limit ?? 20, false);
  } else if (command === "assistant-messages") {
    result = await fetchRecent(String(input.chatId ?? ""), input.limit ?? 20, true);
  } else {
    throw new Error(`unknown command: ${command}`);
  }

  process.stdout.write(JSON.stringify(result));
} catch (e: any) {
  process.stderr.write(e.message ?? String(e));
  process.exit(1);
}
