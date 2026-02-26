import { createClient } from "@supabase/supabase-js";
import { EMBEDDING_DIMS, EMBEDDING_MODEL, EMBEDDING_TIMEOUT_MS } from "./constants";

export const DEFAULT_EMBEDDING_PROFILE_ID = "default-512";

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
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    keepalive: false,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      Connection: "close",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMS,
    }),
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
  } as RequestInit);

  if (!res.ok) {
    throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

async function hashText(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(digest).toString("hex");
}

export async function getActiveEmbeddingProfileId(): Promise<string> {
  const { data, error } = await supabase
    .from("embedding_profiles")
    .select("id")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return DEFAULT_EMBEDDING_PROFILE_ID;
  return String((data as { id: string }).id || DEFAULT_EMBEDDING_PROFILE_ID);
}

export async function upsertBlockEmbedding(input: {
  blockType: "user" | "mua";
  blockId: string;
  text: string;
  profileId?: string;
}): Promise<void> {
  const trimmed = input.text.trim();
  if (!trimmed) return;

  const embedding = await embed(trimmed);
  const textHash = await hashText(trimmed);
  const profileId = input.profileId ?? (await getActiveEmbeddingProfileId());

  await supabase
    .from("block_embeddings")
    .upsert({
      block_type: input.blockType,
      block_id: input.blockId,
      profile_id: profileId,
      text_hash: textHash,
      embedding,
      updated_at: new Date().toISOString(),
    }, { onConflict: "block_type,block_id,profile_id" });
}
