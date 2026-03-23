import pc from "picocolors";
import {
  buildClarificationDigest,
  createMuaBlock,
  createUserBlock,
  getCrmSummary,
  ingestFilesInbox,
  listArtifacts,
  processPendingState,
  resolveClarification,
  searchRelatedBlocks,
  type BlockScope,
  type BlockSource,
  type BlockVisibility,
} from "./blocks";
import { supabase } from "./db";

const heading = (msg: string) => console.log(pc.bold(msg));
const ok = (msg: string) => console.log(pc.green(`✓ ${msg}`));
const warn = (msg: string) => console.log(pc.yellow(`⚠ ${msg}`));
const dim = (msg: string) => console.log(pc.dim(msg));

interface ParsedFlagArgs {
  values: Record<string, string>;
  flags: Set<string>;
}

function parseArgs(args: string[]): ParsedFlagArgs {
  const values: Record<string, string> = {};
  const flags = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    if (args[i + 1] && !args[i + 1].startsWith("--")) {
      values[a.slice(2)] = args[i + 1];
      i += 1;
    } else {
      flags.add(a.slice(2));
    }
  }

  return { values, flags };
}

function printWriteHelp(scope: BlockScope, visibility: BlockVisibility): void {
  console.log();
  heading("Write Mode");
  dim(`scope=${scope} visibility=${visibility}`);
  dim("enter one block per line. press enter to save block.");
  dim("commands: /q /help /scope user|all /next /prev /show /public /private");
  console.log();
}

function truncate(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export async function writeCommand(): Promise<void> {
  let scope: BlockScope = "user";
  let visibility: BlockVisibility = "private";
  let page = 0;
  let lastQuery = "";
  const pageSize = 6;

  printWriteHelp(scope, visibility);

  while (true) {
    const input = prompt(pc.cyan("block> "));
    if (!input) continue;

    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.trim().split(/\s+/);

      if (cmd === "/q" || cmd === "/quit" || cmd === "/exit") {
        ok("write mode closed");
        return;
      }
      if (cmd === "/help") {
        printWriteHelp(scope, visibility);
        continue;
      }
      if (cmd === "/scope") {
        const val = rest[0];
        if (val === "user" || val === "all") {
          scope = val;
          page = 0;
          ok(`scope set to ${scope}`);
        } else {
          warn("usage: /scope user|all");
        }
        continue;
      }
      if (cmd === "/public") {
        visibility = "public";
        ok("new blocks set to public");
        continue;
      }
      if (cmd === "/private") {
        visibility = "private";
        ok("new blocks set to private");
        continue;
      }
      if (cmd === "/next") {
        if (!lastQuery) {
          warn("write a block first to load related results");
          continue;
        }
        page += 1;
        await showRelated(lastQuery, scope, page, pageSize);
        continue;
      }
      if (cmd === "/prev") {
        if (!lastQuery) {
          warn("write a block first to load related results");
          continue;
        }
        page = Math.max(0, page - 1);
        await showRelated(lastQuery, scope, page, pageSize);
        continue;
      }
      if (cmd === "/show") {
        if (!lastQuery) {
          warn("write a block first to load related results");
          continue;
        }
        await showRelated(lastQuery, scope, page, pageSize);
        continue;
      }

      warn("unknown command — /help");
      continue;
    }

    const created = await createUserBlock({ rawContent: input, visibility, source: "cli" });
    ok(`saved block ${created.id}`);

    lastQuery = created.content;
    page = 0;
    await showRelated(lastQuery, scope, page, pageSize);
  }
}

async function showRelated(query: string, scope: BlockScope, page: number, pageSize: number): Promise<void> {
  const offset = page * pageSize;
  const rows = await searchRelatedBlocks({ query, scope, offset, limit: pageSize });

  console.log();
  heading(`Related Blocks (scope=${scope}, page=${page + 1})`);
  if (rows.length === 0) {
    dim("no related blocks found");
    console.log();
    return;
  }

  rows.forEach((r, idx) => {
    const rank = offset + idx + 1;
    const typeTag = r.authorType === "user" ? pc.cyan("user") : pc.magenta("mua");
    const score = r.score.toFixed(2);
    console.log(`${rank}. [${typeTag}] [${r.source}] score=${score}`);
    if (r.blockKind) dim(`   kind=${r.blockKind}`);
    console.log(`   ${truncate(r.content, 180)}`);
  });
  console.log();
}

export async function crmCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const topicFilter = parsed.values.topic;
  const peopleFilter = parsed.values.person;
  const limit = parsed.values.limit ? Number(parsed.values.limit) : 20;

  heading("CRM View\n");

  const rows = await getCrmSummary({
    topicFilter,
    peopleFilter,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 20,
  });

  if (rows.length === 0) {
    dim("no crm rows yet. write notes mentioning people and run ingest flows first.");
    return;
  }

  rows.forEach((row, idx) => {
    const days = row.daysSinceContact === null ? "never" : `${row.daysSinceContact}d`;
    const topics = row.recentTopics.length > 0 ? row.recentTopics.join(", ") : "none";
    console.log(`${idx + 1}. ${pc.bold(row.name)} ${row.verified ? pc.green("[verified]") : pc.yellow("[candidate]")}`);
    console.log(`   roi=${row.roiScore.toFixed(2)} open_loops=${row.openLoops} last_contact=${days}`);
    console.log(`   topics=${topics}`);

    const timelinePreview = row.timeline.slice(0, 3);
    for (const t of timelinePreview) {
      const actor = t.authorType === "user" ? "you" : "mua";
      console.log(`   - (${actor}/${t.source}) ${truncate(t.content, 120)}`);
    }
    console.log();
  });
}

export async function inboxCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const limit = parsed.values.limit ? Number(parsed.values.limit) : 50;
  const sourceFilter = parsed.values.source;
  const statusFilter = parsed.values.status;

  heading("Inbox Artifacts\n");

  let rows = await listArtifacts(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50);
  if (sourceFilter) rows = rows.filter((r) => String(r.source_type) === sourceFilter);
  if (statusFilter) rows = rows.filter((r) => String(r.ingest_status) === statusFilter);

  if (rows.length === 0) {
    dim("no artifacts found");
    return;
  }

  for (const row of rows) {
    const id = String(row.id);
    const source = String(row.source_type);
    const title = row.title ? String(row.title) : "(untitled)";
    const status = String(row.ingest_status);
    const err = row.error ? ` error=${String(row.error)}` : "";

    console.log(`${id}`);
    console.log(`  ${source} | ${status} | ${title}${err}`);
  }
}

export async function ingestCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const parsed = parseArgs(args.slice(1));
  const source = parsed.values.source ?? "all";

  if (sub !== "run") {
    heading("Ingest Commands\n");
    console.log("usage: bun muavin ingest run --source <files|email|apple-notes|apple-reminders|all>");
    return;
  }

  const targets = source === "all"
    ? ["files", "email", "apple-notes", "apple-reminders"]
    : [source];

  for (const t of targets) {
    if (t === "files") {
      heading("Ingest: files");
      const result = await ingestFilesInbox();
      ok(`scanned=${result.scanned} ingested=${result.ingested} skipped=${result.skipped} errored=${result.errored}`);
      console.log();
      continue;
    }

    heading(`Ingest: ${t}`);
    warn(`${t} connector not implemented yet in this alpha. schema and ingestion path are ready.`);
    console.log();
  }
}

export async function clarifyCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "run";
  const parsed = parseArgs(args.slice(1));

  if (sub === "run") {
    const text = await buildClarificationDigest(30);
    if (!text) {
      dim("no pending clarifications");
      return;
    }
    heading("Clarification Digest\n");
    console.log(text);
    return;
  }

  if (sub === "answer") {
    const id = parsed.values.id;
    const option = parsed.values.option ? Number(parsed.values.option) : NaN;
    if (!id || !Number.isFinite(option)) {
      warn("usage: bun muavin clarify answer --id <clarification-id> --option <number>");
      return;
    }

    const result = await resolveClarification({ id, optionIndex: option });
    if (result.ok) ok(result.message);
    else warn(result.message);
    return;
  }

  heading("Clarify Commands\n");
  console.log("usage:");
  console.log("  bun muavin clarify run");
  console.log("  bun muavin clarify answer --id <clarification-id> --option <number>");
}

export async function searchCommand(args: string[]): Promise<void> {
  const query = args.find((a) => !a.startsWith("--")) ?? "";
  if (!query) {
    process.stderr.write("usage: bun muavin blocks search \"query\" [--limit N] [--json]\n");
    process.exit(1);
  }
  const parsed = parseArgs(args);
  const limit = parsed.values.limit ? Number(parsed.values.limit) : 5;
  const jsonOut = parsed.flags.has("json");

  const rows = await searchRelatedBlocks({ query, scope: "all", limit: Number.isFinite(limit) && limit > 0 ? limit : 5 });

  if (jsonOut) {
    process.stdout.write(JSON.stringify(rows.map((r) => ({
      id: r.id,
      content: r.content,
      source: r.source,
      author_type: r.authorType,
      block_kind: r.blockKind,
      created_at: r.createdAt,
      score: r.score,
    }))) + "\n");
    return;
  }

  if (rows.length === 0) {
    dim("no results found");
    return;
  }

  rows.forEach((r, idx) => {
    const typeTag = r.authorType === "user" ? pc.cyan("user") : pc.magenta("mua");
    const score = r.score.toFixed(2);
    const date = r.createdAt.slice(0, 10);
    console.log(`${idx + 1}. [${typeTag}] [${r.source}] score=${score} date=${date}`);
    if (r.blockKind) dim(`   kind=${r.blockKind}`);
    console.log(`   ${truncate(r.content, 200)}`);
  });
}

export async function createCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const jsonFlag = parsed.flags.has("json");

  let content = parsed.values.content ?? "";
  if (!content) {
    content = (await Bun.stdin.text()).trim();
  }
  if (!content) {
    process.stderr.write("error: --content is required or pipe content via stdin\n");
    process.exit(1);
  }

  const source = (parsed.values.source ?? "live") as BlockSource;
  const kind = parsed.values.kind ?? "user";
  const metadataRaw = parsed.values.metadata;
  const metadata: Record<string, unknown> = metadataRaw ? (JSON.parse(metadataRaw) as Record<string, unknown>) : {};

  let id: string;
  if (kind === "mua") {
    const result = await createMuaBlock({ content, source, blockKind: "note", metadata });
    id = result.id;
  } else {
    const result = await createUserBlock({ rawContent: content, source, metadata });
    id = result.id;
  }

  if (jsonFlag) {
    process.stdout.write(JSON.stringify({ id }) + "\n");
  } else {
    process.stdout.write(id + "\n");
  }
}

interface RecentBlockRow {
  id: string;
  author_type: "user" | "mua";
  content: string;
  source: string;
  block_kind: string | null;
  created_at: string;
}

export async function recentCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const limit = parsed.values.limit ? Number(parsed.values.limit) : 10;
  const jsonOut = parsed.flags.has("json");

  const { data, error } = await supabase
    .from("all_blocks_v")
    .select("id, author_type, content, source, block_kind, created_at")
    .order("created_at", { ascending: false })
    .limit(Number.isFinite(limit) && limit > 0 ? limit : 10);

  if (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }

  const rows = (data ?? []) as RecentBlockRow[];

  if (jsonOut) {
    process.stdout.write(JSON.stringify(rows) + "\n");
    return;
  }

  if (rows.length === 0) {
    dim("no blocks found");
    return;
  }

  for (const r of rows) {
    const typeTag = r.author_type === "user" ? pc.cyan("user") : pc.magenta("mua");
    const date = r.created_at.slice(0, 16).replace("T", " ");
    console.log(`[${typeTag}] [${r.source}] ${date}`);
    if (r.block_kind) dim(`  kind=${r.block_kind}`);
    console.log(`  ${truncate(r.content, 200)}`);
  }
}

export async function blocksCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "search":
      await searchCommand(rest);
      break;
    case "create":
      await createCommand(rest);
      break;
    case "recent":
      await recentCommand(rest);
      break;
    default:
      process.stderr.write("usage: bun muavin blocks <search|create|recent>\n");
      process.exit(1);
  }
}

export async function processCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "run";
  const parsed = parseArgs(args.slice(1));

  if (sub !== "run") {
    heading("Process Commands\n");
    console.log("usage: bun muavin process run [--user-limit <n>] [--artifact-limit <n>]");
    return;
  }

  const userLimit = parsed.values["user-limit"] ? Number(parsed.values["user-limit"]) : 20;
  const artifactLimit = parsed.values["artifact-limit"] ? Number(parsed.values["artifact-limit"]) : 10;
  const result = await processPendingState({
    userLimit: Number.isFinite(userLimit) && userLimit > 0 ? userLimit : 20,
    artifactLimit: Number.isFinite(artifactLimit) && artifactLimit > 0 ? artifactLimit : 10,
  });

  heading("State Processor\n");
  console.log(`user blocks: scanned=${result.userScanned} processed=${result.userProcessed} errored=${result.userErrored}`);
  console.log(`artifacts:   scanned=${result.artifactsScanned} processed=${result.artifactsProcessed} errored=${result.artifactsErrored}`);
}
