/**
 * Short-lived subprocess for supabase/openai calls.
 * Sidesteps bun's connection pool/DNS issues in long-running processes.
 *
 * Usage:
 *   echo '{"query":"...","limit":3}' | bun run src/memory-worker.ts search
 *   echo '{"chatId":"123","limit":20}' | bun run src/memory-worker.ts recent
 */
import { validateEnv } from "./env";
validateEnv();

import { searchContext, getRecentMessages } from "./memory";

const command = process.argv[2];
const input = JSON.parse(await Bun.stdin.text());

try {
  let result: unknown;

  if (command === "search") {
    result = await searchContext(input.query, input.limit ?? 3);
  } else if (command === "recent") {
    result = await getRecentMessages(input.chatId, input.limit ?? 20);
  } else {
    throw new Error(`unknown command: ${command}`);
  }

  process.stdout.write(JSON.stringify(result));
} catch (e: any) {
  process.stderr.write(e.message ?? String(e));
  process.exit(1);
}
