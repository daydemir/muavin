import pc from "picocolors";
import { ackAction, closeAction, mergeEntities } from "./blocks";
import {
  getActionsList,
  getBoardOverview,
  getEntityDetailById,
  getEntitiesList,
  resolveEntityByName,
} from "./board-data";

const heading = (msg: string) => console.log(pc.bold(msg));
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
    const value = args[i];
    if (!value.startsWith("--")) continue;
    if (args[i + 1] && !args[i + 1].startsWith("--")) {
      values[value.slice(2)] = args[i + 1];
      i += 1;
    } else {
      flags.add(value.slice(2));
    }
  }

  return { values, flags };
}

function truncate(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function formatDate(value: string): string {
  return value.slice(0, 10);
}

function recordOf(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

export async function boardOverviewCommand(): Promise<void> {
  const overview = await getBoardOverview();

  heading("Board\n");
  console.log("Blocks");
  console.log(`  user: ${overview.blocks.user}  mua: ${overview.blocks.mua} (note=${overview.blocks.note} action_open=${overview.blocks.actionOpen} action_closed=${overview.blocks.actionClosed})`);
  console.log(`  this week: ${overview.thisWeek} blocks`);
  console.log(`  open actions: ${overview.actionStats.total}`);
  console.log(`  due for surfacing: ${overview.actionStats.due}`);
  console.log(`  unacknowledged open actions: ${overview.actionStats.unacknowledged}`);
  console.log(`  actions by type: ${Object.entries(overview.actionStats.byType).map(([type, count]) => `${type}=${count}`).join("  ") || "none"}`);
  console.log();

  console.log("Open Actions (top 5)");
  if (overview.topActions.length === 0) {
    dim("  none");
  } else {
    overview.topActions.forEach((action, idx) => {
      const actionType = action.actionType ? ` [${action.actionType}]` : "";
      const dueState = action.isDue ? "due" : `deferred until ${formatDate(action.nextSurfaceAt ?? "")}`;
      console.log(`  ${idx + 1}. [${formatDate(action.createdAt)}]${actionType} ${truncate(action.content, 90)}`);
      console.log(`     ${dueState}`);
    });
  }
  console.log();

  console.log("Active Entities (top 5)");
  if (overview.topEntities.length === 0) {
    dim("  none");
  } else {
    overview.topEntities.forEach((entity, idx) => {
      console.log(`  ${idx + 1}. ${entity.name} (${entity.linkedBlocks} blocks)`);
    });
  }
  console.log();
  console.log(`Pending Clarifications: ${overview.pendingClarifications}`);
}

export async function boardActionsCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const closed = parsed.flags.has("closed");
  const limitValue = parsed.values.limit ? Number(parsed.values.limit) : 20;
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(limitValue, 100) : 20;
  const rows = await getActionsList({ closed, limit });

  heading(closed ? "Closed Actions\n" : "Open Actions\n");
  if (rows.length === 0) {
    dim("no actions found");
    return;
  }

  rows.forEach((row, idx) => {
    const actionType = row.actionType ? ` [${row.actionType}]` : "";
    console.log(`${idx + 1}. [${formatDate(row.createdAt)}]${actionType} ${truncate(row.content, 120)}`);
    console.log(`   entities=${row.entities.length > 0 ? row.entities.map((entity) => entity.name).join(", ") : "none"}`);
    console.log(`   source=${row.sourcePreview ?? "none"}`);
    if (!closed) {
      console.log(`   surface=${row.isDue ? "due" : `deferred until ${row.nextSurfaceAt ?? "unknown"}`}`);
    }
    if (row.lastAcknowledgedAt) {
      console.log(`   acknowledged=${row.lastAcknowledgedAt}`);
    }
  });
}

export async function boardEntitiesCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const limitValue = parsed.values.limit ? Number(parsed.values.limit) : 30;
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(limitValue, 100) : 30;
  const rows = await getEntitiesList({ limit });

  heading("Entities\n");
  if (rows.length === 0) {
    dim("no linked entities found");
    return;
  }

  rows.forEach((row, idx) => {
    console.log(`${idx + 1}. ${pc.bold(row.name)}`);
    console.log(`   aliases=${row.aliasCount} linked_blocks=${row.linkedBlocks} recent_14d=${row.recentBlocks}`);
  });
}

export async function boardEntityCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const limitValue = parsed.values.limit ? Number(parsed.values.limit) : 30;
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(limitValue, 100) : 30;
  const nameArg = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!nameArg.trim()) {
    warn('usage: bun muavin board entity "<name>" [--limit N]');
    return;
  }

  const resolved = await resolveEntityByName(nameArg);
  if (!resolved.entity) {
    if (resolved.matches.length === 0) {
      warn(`entity not found: ${nameArg}`);
      return;
    }

    heading("Entity Matches\n");
    resolved.matches.slice(0, 10).forEach((entity, idx) => {
      console.log(`${idx + 1}. ${entity.name}`);
    });
    return;
  }

  const detail = await getEntityDetailById(resolved.entity.id, { limit });
  if (!detail) {
    warn(`entity not found: ${nameArg}`);
    return;
  }

  heading(`Entity: ${detail.name}\n`);
  console.log(`aliases: ${detail.aliases.length > 0 ? detail.aliases.join(", ") : "none"}`);
  console.log();

  console.log("Open Actions");
  if (detail.openActions.length === 0) {
    dim("  none");
  } else {
    detail.openActions.slice(0, 10).forEach((action, idx) => {
      console.log(`  ${idx + 1}. [${formatDate(action.createdAt)}] ${truncate(action.content, 100)}`);
    });
  }
  console.log();

  console.log("Timeline");
  if (detail.timeline.length === 0) {
    dim("  none");
  } else {
    detail.timeline.forEach((entry, idx) => {
      const label = entry.type === "user_block"
        ? `[user/${entry.source ?? ""}] ${truncate(entry.content, 140)}`
        : `[mua/${entry.source ?? ""}/${entry.blockKind ?? "note"}] ${truncate(entry.content, 140)}`;
      console.log(`  ${idx + 1}. [${formatDate(entry.createdAt)}] ${label}`);
    });
  }
  console.log();

  console.log("Related Entities");
  if (detail.relatedEntities.length === 0) {
    dim("  none");
  } else {
    detail.relatedEntities.forEach((entity, idx) => {
      console.log(`  ${idx + 1}. ${entity.name} (${entity.sharedBlocks} shared blocks)`);
    });
  }
}

export async function boardAckCommand(args: string[]): Promise<void> {
  const blockId = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!blockId) {
    warn("usage: bun muavin board ack <block_id>");
    return;
  }
  await ackAction(blockId);
  console.log(`acknowledged ${blockId}`);
}

export async function boardDoneCommand(args: string[]): Promise<void> {
  const blockId = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!blockId) {
    warn("usage: bun muavin board done <block_id>");
    return;
  }
  await closeAction(blockId, { closedReason: "done" });
  console.log(`completed ${blockId}`);
}

export async function boardArchiveCommand(args: string[]): Promise<void> {
  const blockId = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!blockId) {
    warn("usage: bun muavin board archive <block_id>");
    return;
  }
  await closeAction(blockId, { closedReason: "archived" });
  console.log(`archived ${blockId}`);
}

export async function boardMergeCommand(args: string[]): Promise<void> {
  const entityArgs = args.filter((arg) => !arg.startsWith("--"));
  const keepName = entityArgs[0] ?? "";
  const mergeName = entityArgs[1] ?? "";
  if (!keepName || !mergeName) {
    warn('usage: bun muavin board merge "<entity1>" "<entity2>"');
    return;
  }

  const keepResolved = await resolveEntityByName(keepName);
  const mergeResolved = await resolveEntityByName(mergeName);
  if (!keepResolved.entity || keepResolved.matches.length > 1) {
    warn(`could not resolve merge target: ${keepName}`);
    return;
  }
  if (!mergeResolved.entity || mergeResolved.matches.length > 1) {
    warn(`could not resolve merge source: ${mergeName}`);
    return;
  }

  await mergeEntities(keepResolved.entity.id, mergeResolved.entity.id);
  console.log(`merged ${mergeResolved.entity.name} into ${keepResolved.entity.name}`);
}

export async function boardCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case undefined:
      await boardOverviewCommand();
      break;
    case "actions":
      await boardActionsCommand(rest);
      break;
    case "entities":
      await boardEntitiesCommand(rest);
      break;
    case "entity":
      await boardEntityCommand(rest);
      break;
    case "ack":
      await boardAckCommand(rest);
      break;
    case "done":
      await boardDoneCommand(rest);
      break;
    case "archive":
      await boardArchiveCommand(rest);
      break;
    case "merge":
      await boardMergeCommand(rest);
      break;
    default:
      heading("Board Commands\n");
      console.log("usage:");
      console.log("  bun muavin board");
      console.log("  bun muavin board actions [--closed] [--limit N]");
      console.log("  bun muavin board entities [--limit N]");
      console.log('  bun muavin board entity "<name>" [--limit N]');
      console.log("  bun muavin board done <block_id>");
      console.log("  bun muavin board archive <block_id>");
      console.log("  bun muavin board ack <block_id>");
      console.log('  bun muavin board merge "<entity1>" "<entity2>"');
  }
}
