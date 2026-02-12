import { validateEnv } from "../src/env";
validateEnv();

import { embed, supabase } from "../src/memory";

const BATCH_SIZE = 20;
const DELAY_MS = 500;

async function reembedTable(table: "memory" | "messages") {
  const { data, error } = await supabase
    .from(table)
    .select("id, content")
    .is("embedding", null);

  if (error) {
    console.error(`Failed to fetch ${table}:`, error.message);
    return;
  }
  if (!data || data.length === 0) {
    console.log(`${table}: no rows to re-embed`);
    return;
  }

  console.log(`${table}: ${data.length} rows to re-embed`);
  let done = 0;

  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE);
    for (const row of batch) {
      const embedding = await embed(row.content);
      const { error: updateError } = await supabase
        .from(table)
        .update({ embedding })
        .eq("id", row.id);
      if (updateError) {
        console.error(`${table} row ${row.id}: update failed:`, updateError.message);
      }
      done++;
    }
    console.log(`${table}: ${done}/${data.length}`);
    if (i + BATCH_SIZE < data.length) await Bun.sleep(DELAY_MS);
  }

  console.log(`${table}: done`);
}

async function main() {
  await reembedTable("memory");
  await reembedTable("messages");
  console.log("Re-embedding complete");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
