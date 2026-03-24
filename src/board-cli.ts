import pc from "picocolors";
import { ackAction, closeAction, mergeEntities } from "./blocks";
import { supabase } from "./db";
import { runLLM } from "./llm";

const heading = (msg: string) => console.log(pc.bold(msg));
const warn = (msg: string) => console.log(pc.yellow(`⚠ ${msg}`));
const dim = (msg: string) => console.log(pc.dim(msg));
const ACTION_REVIEW_BATCH_SIZE = 20;

interface ParsedFlagArgs {
  values: Record<string, string>;
  flags: Set<string>;
}

interface EntityRow {
  id: string;
  name: string;
  aliases: string[];
}

interface ActionDetails {
  id: string;
  content: string;
  created_at: string;
  entityNames: string[];
  sourcePreview: string | null;
  lastAcknowledgedAt: string | null;
}

interface EntityStats {
  entity: EntityRow;
  linkedBlockCount: number;
  recentBlockCount: number;
}

interface CleanupClassification {
  id: string;
  classification: "VALID" | "RECLASSIFY" | "DUPLICATE" | "STALE";
  duplicate_of: string | null;
  reason: string;
}

const ACTION_CLEANUP_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          classification: { type: "string", enum: ["VALID", "RECLASSIFY", "DUPLICATE", "STALE"] },
          duplicate_of: { type: ["string", "null"] },
          reason: { type: "string" },
        },
        required: ["id", "classification", "duplicate_of", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

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

function truncate(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function recordOf(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

function isCandidateRelatedLink(row: Record<string, unknown>): boolean {
  const metadata = recordOf(row.metadata);
  return String(row.link_type ?? "") === "related" && metadata.candidate_match === true;
}

function formatDate(value: string): string {
  return value.slice(0, 10);
}

async function fetchEntitiesByIds(ids: string[]): Promise<Map<string, EntityRow>> {
  if (ids.length === 0) return new Map();
  const { data } = await supabase
    .from("entities")
    .select("id, name, aliases")
    .in("id", ids);

  return new Map(
    ((data ?? []) as Array<Record<string, unknown>>).map((row) => [
      String(row.id),
      {
        id: String(row.id),
        name: String(row.name ?? ""),
        aliases: (row.aliases as string[] | undefined) ?? [],
      },
    ]),
  );
}

async function fetchUserBlocksByIds(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  if (ids.length === 0) return new Map();
  const { data } = await supabase
    .from("user_blocks")
    .select("id, content, source, created_at")
    .in("id", ids);
  return new Map(((data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.id), row]));
}

async function fetchMuaBlocksByIds(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  if (ids.length === 0) return new Map();
  const { data } = await supabase
    .from("mua_blocks")
    .select("id, content, source, created_at, block_kind")
    .in("id", ids);
  return new Map(((data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.id), row]));
}

async function listActionDetails(kind: "action_open" | "action_closed", limit: number): Promise<ActionDetails[]> {
  const { data } = await supabase
    .from("mua_blocks")
    .select("id, content, created_at, metadata")
    .eq("block_kind", kind)
    .order("created_at", { ascending: false })
    .limit(limit);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];

  const ids = rows.map((row) => String(row.id));
  const { data: linkRows } = await supabase
    .from("links")
    .select("from_id, to_type, to_id, link_type, metadata")
    .eq("from_type", "mua_block")
    .in("from_id", ids)
    .in("link_type", ["about", "derived_from"]);

  const links = (linkRows ?? []) as Array<Record<string, unknown>>;
  const entityIds = [...new Set(links.filter((row) => row.to_type === "entity").map((row) => String(row.to_id)))];
  const sourceIds = [...new Set(links.filter((row) => row.to_type === "user_block").map((row) => String(row.to_id)))];

  const [entitiesById, userBlocksById] = await Promise.all([
    fetchEntitiesByIds(entityIds),
    fetchUserBlocksByIds(sourceIds),
  ]);

  const entityNamesByAction = new Map<string, string[]>();
  const sourcePreviewByAction = new Map<string, string>();

  for (const link of links) {
    const actionId = String(link.from_id);
    if (String(link.to_type) === "entity") {
      const entity = entitiesById.get(String(link.to_id));
      if (!entity) continue;
      const names = entityNamesByAction.get(actionId) ?? [];
      if (!names.includes(entity.name)) names.push(entity.name);
      entityNamesByAction.set(actionId, names);
      continue;
    }

    if (String(link.to_type) === "user_block" && !sourcePreviewByAction.has(actionId)) {
      const block = userBlocksById.get(String(link.to_id));
      if (block) {
        sourcePreviewByAction.set(actionId, truncate(String(block.content ?? ""), 120));
      }
    }
  }

  return rows.map((row) => ({
    id: String(row.id),
    content: String(row.content ?? ""),
    created_at: String(row.created_at ?? ""),
    entityNames: entityNamesByAction.get(String(row.id)) ?? [],
    sourcePreview: sourcePreviewByAction.get(String(row.id)) ?? null,
    lastAcknowledgedAt: (() => {
      const metadata = recordOf(row.metadata);
      return typeof metadata.last_acknowledged_at === "string" ? metadata.last_acknowledged_at : null;
    })(),
  })).sort((a, b) => {
    const aUnack = a.lastAcknowledgedAt ? 1 : 0;
    const bUnack = b.lastAcknowledgedAt ? 1 : 0;
    if (aUnack !== bUnack) return aUnack - bUnack;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

async function loadEntityStats(): Promise<EntityStats[]> {
  const [{ data: entitiesData }, { data: linksData }] = await Promise.all([
    supabase.from("entities").select("id, name, aliases").limit(500),
    supabase
      .from("links")
      .select("to_id, from_type, from_id, metadata, link_type")
      .eq("to_type", "entity")
      .in("from_type", ["user_block", "mua_block"])
      .limit(5000),
  ]);

  const entities = ((entitiesData ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    aliases: (row.aliases as string[] | undefined) ?? [],
  }));

  const blockLinks = ((linksData ?? []) as Array<Record<string, unknown>>)
    .filter((row) => !isCandidateRelatedLink(row));

  const userIds = [...new Set(blockLinks.filter((row) => row.from_type === "user_block").map((row) => String(row.from_id)))];
  const muaIds = [...new Set(blockLinks.filter((row) => row.from_type === "mua_block").map((row) => String(row.from_id)))];
  const [userBlocksById, muaBlocksById] = await Promise.all([
    fetchUserBlocksByIds(userIds),
    fetchMuaBlocksByIds(muaIds),
  ]);

  const cutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);
  const blockIdsByEntity = new Map<string, Set<string>>();
  const recentIdsByEntity = new Map<string, Set<string>>();

  for (const link of blockLinks) {
    const entityId = String(link.to_id);
    const blockId = String(link.from_id);
    const block = String(link.from_type) === "user_block"
      ? userBlocksById.get(blockId)
      : muaBlocksById.get(blockId);
    if (!block) continue;

    const allIds = blockIdsByEntity.get(entityId) ?? new Set<string>();
    allIds.add(blockId);
    blockIdsByEntity.set(entityId, allIds);

    const createdAt = String(block.created_at ?? "");
    if (createdAt && new Date(createdAt).getTime() >= cutoff) {
      const recentIds = recentIdsByEntity.get(entityId) ?? new Set<string>();
      recentIds.add(blockId);
      recentIdsByEntity.set(entityId, recentIds);
    }
  }

  return entities.map((entity) => ({
    entity,
    linkedBlockCount: blockIdsByEntity.get(entity.id)?.size ?? 0,
    recentBlockCount: recentIdsByEntity.get(entity.id)?.size ?? 0,
  }));
}

async function resolveEntityByName(rawName: string): Promise<{ entity: EntityRow | null; matches: EntityRow[] }> {
  const name = rawName.trim().toLowerCase();
  if (!name) return { entity: null, matches: [] };

  const { data } = await supabase
    .from("entities")
    .select("id, name, aliases")
    .order("updated_at", { ascending: false })
    .limit(300);

  const entities = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    aliases: (row.aliases as string[] | undefined) ?? [],
  }));

  const exactName = entities.filter((entity) => entity.name.toLowerCase() === name);
  if (exactName.length === 1) return { entity: exactName[0], matches: exactName };
  if (exactName.length > 1) return { entity: null, matches: exactName };

  const exactAlias = entities.filter((entity) => entity.aliases.some((alias) => alias.toLowerCase() === name));
  if (exactAlias.length === 1) return { entity: exactAlias[0], matches: exactAlias };
  if (exactAlias.length > 1) return { entity: null, matches: exactAlias };

  const partial = entities.filter((entity) =>
    entity.name.toLowerCase().includes(name) || entity.aliases.some((alias) => alias.toLowerCase().includes(name)));
  if (partial.length === 1) return { entity: partial[0], matches: partial };
  return { entity: null, matches: partial };
}

async function reviewActionBatch(batch: ActionDetails[]): Promise<CleanupClassification[]> {
  const prompt = [
    "Review these open action blocks for Muavin.",
    "Classify each block as one of:",
    "- VALID: real, still-relevant task",
    "- RECLASSIFY: not actually an action; should become a note",
    "- DUPLICATE: duplicate of another block id from this batch; set duplicate_of to the surviving id",
    "- STALE: action is no longer relevant and should be closed",
    "",
    "Rules:",
    "- Return exactly one item per input id.",
    "- `duplicate_of` must be null unless classification is DUPLICATE.",
    "- For DUPLICATE, `duplicate_of` must be another id from this batch, never itself.",
    "- Prefer VALID unless the block is clearly not actionable, duplicated, or stale.",
    "",
    "blocks:",
    JSON.stringify(batch.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      content: row.content,
      entities: row.entityNames,
      source_preview: row.sourcePreview,
    })), null, 2),
  ].join("\n");

  const result = await runLLM({
    task: "board_cleanup_actions",
    prompt,
    ephemeral: true,
    maxTurns: 4,
    timeoutMs: 180_000,
    jsonSchema: ACTION_CLEANUP_SCHEMA,
  });

  const payload = typeof result.structuredOutput === "string"
    ? JSON.parse(result.structuredOutput)
    : result.structuredOutput;
  const items = recordOf(payload).items;
  return Array.isArray(items) ? items as CleanupClassification[] : [];
}

export async function boardOverviewCommand(): Promise<void> {
  const weekAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)).toISOString();
  const [userCount, noteCount, openActions, closedCount, userThisWeek, muaThisWeek, actions, entityStats, clarifications] = await Promise.all([
    supabase.from("user_blocks").select("*", { count: "exact", head: true }),
    supabase.from("mua_blocks").select("*", { count: "exact", head: true }).eq("block_kind", "note"),
    supabase.from("mua_blocks").select("id, metadata").eq("block_kind", "action_open"),
    supabase.from("mua_blocks").select("*", { count: "exact", head: true }).eq("block_kind", "action_closed"),
    supabase.from("user_blocks").select("*", { count: "exact", head: true }).gte("created_at", weekAgo),
    supabase.from("mua_blocks").select("*", { count: "exact", head: true }).gte("created_at", weekAgo),
    listActionDetails("action_open", 5),
    loadEntityStats(),
    supabase.from("clarification_queue").select("*", { count: "exact", head: true }).in("status", ["pending", "asked"]),
  ]);

  const noteTotal = noteCount.count ?? 0;
  const openTotal = (openActions.data ?? []).length;
  const unacknowledgedTotal = ((openActions.data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => typeof recordOf(row.metadata).last_acknowledged_at !== "string")
    .length;
  const closedTotal = closedCount.count ?? 0;
  const muaTotal = noteTotal + openTotal + closedTotal;
  const weekTotal = (userThisWeek.count ?? 0) + (muaThisWeek.count ?? 0);
  const topEntities = entityStats
    .filter((row) => row.linkedBlockCount > 0)
    .sort((a, b) => b.linkedBlockCount - a.linkedBlockCount)
    .slice(0, 5);

  heading("Board\n");
  console.log("Blocks");
  console.log(`  user: ${userCount.count ?? 0}  mua: ${muaTotal} (note=${noteTotal} action_open=${openTotal} action_closed=${closedTotal})`);
  console.log(`  this week: ${weekTotal} blocks`);
  console.log(`  unacknowledged open actions: ${unacknowledgedTotal}`);
  console.log();

  console.log("Open Actions (top 5)");
  if (actions.length === 0) {
    dim("  none");
  } else {
    actions.forEach((action, idx) => {
      console.log(`  ${idx + 1}. [${formatDate(action.created_at)}] ${truncate(action.content, 90)}`);
    });
  }
  console.log();

  console.log("Active Entities (top 5)");
  if (topEntities.length === 0) {
    dim("  none");
  } else {
    topEntities.forEach((row, idx) => {
      console.log(`  ${idx + 1}. ${row.entity.name} (${row.linkedBlockCount} blocks)`);
    });
  }
  console.log();
  console.log(`Pending Clarifications: ${clarifications.count ?? 0}`);
}

export async function boardActionsCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const closed = parsed.flags.has("closed");
  const limitValue = parsed.values.limit ? Number(parsed.values.limit) : 20;
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(limitValue, 100) : 20;
  const rows = await listActionDetails(closed ? "action_closed" : "action_open", limit);

  heading(closed ? "Closed Actions\n" : "Open Actions\n");
  if (rows.length === 0) {
    dim("no actions found");
    return;
  }

  rows.forEach((row, idx) => {
    console.log(`${idx + 1}. [${formatDate(row.created_at)}] ${truncate(row.content, 120)}`);
    console.log(`   entities=${row.entityNames.length > 0 ? row.entityNames.join(", ") : "none"}`);
    console.log(`   source=${row.sourcePreview ?? "none"}`);
    if (row.lastAcknowledgedAt) {
      console.log(`   acknowledged=${row.lastAcknowledgedAt}`);
    }
  });
}

export async function boardEntitiesCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const limitValue = parsed.values.limit ? Number(parsed.values.limit) : 30;
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(limitValue, 100) : 30;
  const rows = (await loadEntityStats())
    .filter((row) => row.linkedBlockCount > 0)
    .sort((a, b) => {
      if (b.linkedBlockCount !== a.linkedBlockCount) return b.linkedBlockCount - a.linkedBlockCount;
      return b.recentBlockCount - a.recentBlockCount;
    })
    .slice(0, limit);

  heading("Entities\n");
  if (rows.length === 0) {
    dim("no linked entities found");
    return;
  }

  rows.forEach((row, idx) => {
    console.log(`${idx + 1}. ${pc.bold(row.entity.name)}`);
    console.log(`   aliases=${row.entity.aliases.length} linked_blocks=${row.linkedBlockCount} recent_14d=${row.recentBlockCount}`);
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

  const entity = resolved.entity;
  const { data: linkRows } = await supabase
    .from("links")
    .select("from_type, from_id, link_type, metadata")
    .eq("to_type", "entity")
    .eq("to_id", entity.id)
    .in("from_type", ["user_block", "mua_block"])
    .limit(1000);

  const links = ((linkRows ?? []) as Array<Record<string, unknown>>)
    .filter((row) => !isCandidateRelatedLink(row));
  const userIds = [...new Set(links.filter((row) => row.from_type === "user_block").map((row) => String(row.from_id)))];
  const muaIds = [...new Set(links.filter((row) => row.from_type === "mua_block").map((row) => String(row.from_id)))];

  const [userBlocksById, muaBlocksById] = await Promise.all([
    fetchUserBlocksByIds(userIds),
    fetchMuaBlocksByIds(muaIds),
  ]);

  const aboutActionIds = links
    .filter((row) => row.from_type === "mua_block" && row.link_type === "about")
    .map((row) => String(row.from_id));
  const openActions = aboutActionIds
    .map((id) => muaBlocksById.get(id))
    .filter((row): row is Record<string, unknown> => Boolean(row) && String(row?.block_kind ?? "") === "action_open")
    .sort((a, b) => new Date(String(b.created_at ?? "")).getTime() - new Date(String(a.created_at ?? "")).getTime());

  const timeline = [
    ...userIds.map((id) => {
      const block = userBlocksById.get(id);
      return block ? {
        at: String(block.created_at ?? ""),
        label: `[user/${String(block.source ?? "")}] ${truncate(String(block.content ?? ""), 140)}`,
      } : null;
    }),
    ...muaIds.map((id) => {
      const block = muaBlocksById.get(id);
      return block ? {
        at: String(block.created_at ?? ""),
        label: `[mua/${String(block.source ?? "")}/${String(block.block_kind ?? "note")}] ${truncate(String(block.content ?? ""), 140)}`,
      } : null;
    }),
  ]
    .filter((row): row is { at: string; label: string } => row !== null)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);

  const sharedBlockIds = [...new Set([...userIds, ...muaIds])];
  const { data: relatedRows } = sharedBlockIds.length === 0
    ? { data: [] as Array<Record<string, unknown>> }
    : await supabase
        .from("links")
        .select("from_id, to_id, metadata, link_type")
        .eq("to_type", "entity")
        .in("from_type", ["user_block", "mua_block"])
        .in("from_id", sharedBlockIds)
        .neq("to_id", entity.id)
        .limit(2000);

  const relatedCounts = new Map<string, Set<string>>();
  for (const row of (relatedRows ?? []) as Array<Record<string, unknown>>) {
    if (isCandidateRelatedLink(row)) continue;
    const otherId = String(row.to_id);
    const blockIds = relatedCounts.get(otherId) ?? new Set<string>();
    blockIds.add(String(row.from_id));
    relatedCounts.set(otherId, blockIds);
  }

  const relatedEntityIds = [...relatedCounts.keys()];
  const relatedEntitiesById = await fetchEntitiesByIds(relatedEntityIds);
  const relatedEntities = relatedEntityIds
    .map((id) => ({ entity: relatedEntitiesById.get(id), count: relatedCounts.get(id)?.size ?? 0 }))
    .filter((row): row is { entity: EntityRow; count: number } => Boolean(row.entity))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  heading(`Entity: ${entity.name}\n`);
  console.log(`aliases: ${entity.aliases.length > 0 ? entity.aliases.join(", ") : "none"}`);
  console.log();

  console.log("Open Actions");
  if (openActions.length === 0) {
    dim("  none");
  } else {
    openActions.slice(0, 10).forEach((row, idx) => {
      console.log(`  ${idx + 1}. [${formatDate(String(row.created_at ?? ""))}] ${truncate(String(row.content ?? ""), 100)}`);
    });
  }
  console.log();

  console.log("Timeline");
  if (timeline.length === 0) {
    dim("  none");
  } else {
    timeline.forEach((row, idx) => {
      console.log(`  ${idx + 1}. [${formatDate(row.at)}] ${row.label}`);
    });
  }
  console.log();

  console.log("Related Entities");
  if (relatedEntities.length === 0) {
    dim("  none");
  } else {
    relatedEntities.forEach((row, idx) => {
      console.log(`  ${idx + 1}. ${row.entity.name} (${row.count} shared blocks)`);
    });
  }
}

export async function boardCleanupActionsCommand(): Promise<void> {
  const actions = await listActionDetails("action_open", 500);
  if (actions.length === 0) {
    dim("no open actions to review");
    return;
  }

  let reviewed = 0;
  let unchanged = 0;
  let reclassified = 0;
  let closed = 0;
  let deduped = 0;
  let errored = 0;
  const allIds = new Set(actions.map((action) => action.id));

  for (let i = 0; i < actions.length; i += ACTION_REVIEW_BATCH_SIZE) {
    const batch = actions.slice(i, i + ACTION_REVIEW_BATCH_SIZE);
    let decisions: CleanupClassification[] = [];
    try {
      decisions = await reviewActionBatch(batch);
    } catch (error) {
      errored += batch.length;
      warn(`cleanup batch failed at offset ${i}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const decisionById = new Map(decisions.map((item) => [item.id, item]));
    for (const action of batch) {
      reviewed += 1;
      const decision = decisionById.get(action.id);
      if (!decision) {
        errored += 1;
        continue;
      }

      if (decision.classification === "VALID") {
        unchanged += 1;
        continue;
      }

      if (decision.classification === "RECLASSIFY") {
        await supabase
          .from("mua_blocks")
          .update({ block_kind: "note", updated_at: new Date().toISOString() })
          .eq("id", action.id)
          .eq("block_kind", "action_open");
        reclassified += 1;
        continue;
      }

      if (decision.classification === "STALE") {
        await closeAction(action.id, { closedReason: "archived" });
        closed += 1;
        continue;
      }

      if (decision.classification === "DUPLICATE") {
        if (!decision.duplicate_of || decision.duplicate_of === action.id || !allIds.has(decision.duplicate_of)) {
          errored += 1;
          continue;
        }
        await closeAction(action.id, { closedReason: "duplicate" });
        deduped += 1;
      }
    }
  }

  heading("Cleanup Actions\n");
  console.log(`reviewed=${reviewed}`);
  console.log(`unchanged=${unchanged}`);
  console.log(`reclassified=${reclassified}`);
  console.log(`closed=${closed}`);
  console.log(`deduped=${deduped}`);
  console.log(`errored=${errored}`);
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
    case "cleanup-actions":
      await boardCleanupActionsCommand();
      break;
    case "ack":
      await boardAckCommand(rest);
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
      console.log("  bun muavin board ack <block_id>");
      console.log('  bun muavin board merge "<entity1>" "<entity2>"');
      console.log("  bun muavin board cleanup-actions");
  }
}
