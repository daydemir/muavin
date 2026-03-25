import pc from "picocolors";
import { spawn } from "bun";
import { createCliDraftNote, finalizeCliDraftNote, getCliNoteList } from "./notes-data";

const heading = (msg: string) => console.log(pc.bold(msg));
const warn = (msg: string) => console.log(pc.yellow(`⚠ ${msg}`));
const dim = (msg: string) => console.log(pc.dim(msg));
const ok = (msg: string) => console.log(pc.green(`✓ ${msg}`));

interface ParsedArgs {
  values: Record<string, string>;
  positionals: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const values: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value.startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--")) {
      values[value.slice(2)] = args[i + 1];
      i += 1;
      continue;
    }
    if (value.startsWith("--")) {
      values[value.slice(2)] = "true";
      continue;
    }
    positionals.push(value);
  }

  return { values, positionals };
}

function truncate(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatDate(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}

async function openInEditor(path: string): Promise<void> {
  const editor = process.env.EDITOR ?? "vi";
  const command = `${editor} ${escapeShellArg(path)}`;
  const proc = spawn(["/bin/zsh", "-lc", command], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`editor exited with code ${exitCode}`);
  }
}

export async function notesCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const sub = parsed.positionals[0];

  if (sub === "new") {
    const draft = await createCliDraftNote();
    await openInEditor(draft.path);
    const finalized = await finalizeCliDraftNote(draft.filename);
    if (!finalized) {
      warn("empty note discarded");
      return;
    }
    ok(`saved ${finalized.filename}`);
    return;
  }

  if (sub !== undefined) {
    warn("usage: bun muavin notes [--tag <tag>]");
    warn("       bun muavin notes new");
    return;
  }

  const rows = await getCliNoteList({
    limit: 20,
    tag: parsed.values.tag,
  });

  heading("Notes\n");
  if (rows.length === 0) {
    dim("no notes found");
    return;
  }

  for (const row of rows) {
    const tags = row.tags.length > 0 ? row.tags.map((tag) => tag.name).join(", ") : "none";
    const sync = row.isSynced ? "" : ` ${pc.yellow("[pending sync]")}`;
    console.log(`${pc.bold(row.filename)}${sync}`);
    console.log(`  ${formatDate(row.createdAt)}`);
    console.log(`  ${truncate(row.preview || row.body, 160)}`);
    console.log(`  tags=${tags}`);
    if (row.syncError) {
      console.log(`  sync_error=${row.syncError}`);
    }
    console.log();
  }
}
