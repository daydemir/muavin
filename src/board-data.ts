import { supabase } from "./db";

const BOARD_CACHE_TTL_MS = 15_000;
const boardCache = new Map<string, { expiresAt: number; promise: Promise<unknown> }>();

export interface EntityRef {
  id: string;
  name: string;
}

export interface ActionItem {
  id: string;
  content: string;
  actionType?: string;
  createdAt: string;
  isDue: boolean;
  isAcknowledged: boolean;
  lastAcknowledgedAt?: string;
  nextSurfaceAt?: string;
  entities: EntityRef[];
  sourcePreview?: string;
}

export interface EntitySummary {
  id: string;
  name: string;
  aliasCount: number;
  linkedBlocks: number;
  recentBlocks: number;
}

export interface TimelineEntry {
  id: string;
  type: "user_block" | "mua_block";
  content: string;
  blockKind?: string;
  createdAt: string;
  source?: string;
}

export interface RelatedEntitySummary {
  id: string;
  name: string;
  sharedBlocks: number;
}

export interface EntityDetail {
  id: string;
  name: string;
  aliases: string[];
  openActions: ActionItem[];
  timeline: TimelineEntry[];
  relatedEntities: RelatedEntitySummary[];
}

export interface BoardOverview {
  blocks: {
    user: number;
    mua: number;
    note: number;
    actionOpen: number;
    actionClosed: number;
  };
  thisWeek: number;
  topActions: ActionItem[];
  topEntities: EntitySummary[];
  pendingClarifications: number;
  actionStats: {
    total: number;
    due: number;
    unacknowledged: number;
    byType: Record<string, number>;
  };
}

export interface EntityRow {
  id: string;
  name: string;
  aliases: string[];
}

export interface EntityResolutionResult {
  entity: EntityRow | null;
  matches: EntityRow[];
}

function truncate(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-zA-Z0-9#]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readablePreview(text: string, max = 120): string | undefined {
  if (text.includes("<task-notification>")) {
    const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (summaryMatch?.[1]) {
      const summary = stripMarkup(summaryMatch[1]);
      if (summary) return truncate(summary, max);
    }

    const resultMatch = text.match(/<result>([\s\S]*?)<\/result>/i);
    if (resultMatch?.[1]) {
      const result = stripMarkup(resultMatch[1]);
      if (result) return truncate(result, max);
    }

    return undefined;
  }

  const stripped = stripMarkup(text);
  return stripped ? truncate(stripped, max) : undefined;
}

function recordOf(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

function isCandidateRelatedLink(row: Record<string, unknown>): boolean {
  const metadata = recordOf(row.metadata);
  return String(row.link_type ?? "") === "related" && metadata.candidate_match === true;
}

function actionTypeOf(metadata: Record<string, unknown>): string | undefined {
  return typeof metadata.action_type === "string" && metadata.action_type.trim()
    ? metadata.action_type.trim()
    : undefined;
}

function nextSurfaceAtOf(metadata: Record<string, unknown>): string | undefined {
  return typeof metadata.next_surface_at === "string" ? metadata.next_surface_at : undefined;
}

function lastAcknowledgedAtOf(metadata: Record<string, unknown>): string | undefined {
  return typeof metadata.last_acknowledged_at === "string" ? metadata.last_acknowledged_at : undefined;
}

function isActionDue(metadata: Record<string, unknown>): boolean {
  const nextSurfaceAt = nextSurfaceAtOf(metadata);
  if (!nextSurfaceAt) return true;
  return new Date(nextSurfaceAt).getTime() <= Date.now();
}

function cacheKey(prefix: string, input?: Record<string, unknown>): string {
  return `${prefix}:${JSON.stringify(input ?? {})}`;
}

function isMissingEntityNameColumn(error: unknown): boolean {
  const record = recordOf(error);
  const message = String(record.message ?? record.details ?? "");
  return String(record.code ?? "") === "42703"
    || message.includes("column entities.name does not exist");
}

function normalizeEntityRow(row: Record<string, unknown>): EntityRow {
  const aliases = Array.isArray(row.aliases)
    ? row.aliases.filter((value): value is string => typeof value === "string")
    : [];
  return {
    id: String(row.id),
    name: String(row.name ?? row.canonical_name ?? ""),
    aliases,
  };
}

async function selectEntitiesByIds(ids: string[]): Promise<EntityRow[]> {
  if (ids.length === 0) return [];

  const primary = await supabase
    .from("entities")
    .select("id, name, aliases")
    .in("id", ids);
  if (!primary.error) {
    return ((primary.data ?? []) as Array<Record<string, unknown>>).map(normalizeEntityRow);
  }
  if (!isMissingEntityNameColumn(primary.error)) throw primary.error;

  const legacy = await supabase
    .from("entities")
    .select("id, canonical_name, aliases")
    .in("id", ids);
  if (legacy.error) throw legacy.error;
  return ((legacy.data ?? []) as Array<Record<string, unknown>>).map(normalizeEntityRow);
}

async function selectAllEntities(limit: number): Promise<EntityRow[]> {
  const primary = await supabase
    .from("entities")
    .select("id, name, aliases")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (!primary.error) {
    return ((primary.data ?? []) as Array<Record<string, unknown>>).map(normalizeEntityRow);
  }
  if (!isMissingEntityNameColumn(primary.error)) throw primary.error;

  const legacy = await supabase
    .from("entities")
    .select("id, canonical_name, aliases")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (legacy.error) throw legacy.error;
  return ((legacy.data ?? []) as Array<Record<string, unknown>>).map(normalizeEntityRow);
}

async function withBoardCache<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = boardCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise as Promise<T>;
  }

  const promise = loader().catch((error) => {
    const current = boardCache.get(key);
    if (current?.promise === promise) boardCache.delete(key);
    throw error;
  });
  boardCache.set(key, { expiresAt: now + BOARD_CACHE_TTL_MS, promise });
  return promise;
}

export function clearBoardDataCache(): void {
  boardCache.clear();
}

export async function warmBoardDataCache(): Promise<void> {
  await Promise.allSettled([
    getActionsList({ limit: 20 }),
    getEntitiesList({ limit: 30 }),
    getBoardOverview(),
  ]);
}

async function fetchEntitiesByIds(ids: string[]): Promise<Map<string, EntityRow>> {
  return new Map((await selectEntitiesByIds(ids)).map((row) => [row.id, row]));
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
    .select("id, content, source, created_at, block_kind, metadata")
    .in("id", ids);
  return new Map(((data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.id), row]));
}

function compareActionRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  kind: "action_open" | "action_closed",
): number {
  if (kind === "action_open") {
    const aDue = isActionDue(recordOf(a.metadata));
    const bDue = isActionDue(recordOf(b.metadata));
    if (aDue !== bDue) return aDue ? -1 : 1;
  }
  return new Date(String(b.created_at ?? "")).getTime() - new Date(String(a.created_at ?? "")).getTime();
}

async function hydrateActionRows(rows: Array<Record<string, unknown>>, kind: "action_open" | "action_closed"): Promise<ActionItem[]> {
  if (rows.length === 0) return [];

  const actionIds = rows.map((row) => String(row.id));
  const { data: linkRows } = await supabase
    .from("links")
    .select("from_id, to_type, to_id, link_type, metadata")
    .eq("from_type", "mua_block")
    .in("from_id", actionIds)
    .in("link_type", ["about", "derived_from"]);

  const links = (linkRows ?? []) as Array<Record<string, unknown>>;
  const entityIds = [...new Set(links.filter((row) => row.to_type === "entity").map((row) => String(row.to_id)))];
  const sourceIds = [...new Set(links.filter((row) => row.to_type === "user_block").map((row) => String(row.to_id)))];

  const [entitiesById, userBlocksById] = await Promise.all([
    fetchEntitiesByIds(entityIds),
    fetchUserBlocksByIds(sourceIds),
  ]);

  const entitiesByAction = new Map<string, EntityRef[]>();
  const sourcePreviewByAction = new Map<string, string>();

  for (const link of links) {
    const actionId = String(link.from_id);
    if (String(link.to_type) === "entity") {
      const entity = entitiesById.get(String(link.to_id));
      if (!entity) continue;
      const items = entitiesByAction.get(actionId) ?? [];
      if (!items.some((item) => item.id === entity.id)) {
        items.push({ id: entity.id, name: entity.name });
      }
      entitiesByAction.set(actionId, items);
      continue;
    }

    if (String(link.to_type) === "user_block" && !sourcePreviewByAction.has(actionId)) {
      const block = userBlocksById.get(String(link.to_id));
      if (block) {
        const preview = readablePreview(String(block.content ?? ""), 120);
        if (preview) {
          sourcePreviewByAction.set(actionId, preview);
        }
      }
    }
  }

  return rows
    .map((row) => {
      const metadata = recordOf(row.metadata);
      const lastAcknowledgedAt = lastAcknowledgedAtOf(metadata);
      const nextSurfaceAt = nextSurfaceAtOf(metadata);
      return {
        id: String(row.id),
        content: String(row.content ?? ""),
        actionType: actionTypeOf(metadata),
        createdAt: String(row.created_at ?? ""),
        isDue: kind === "action_open" ? isActionDue(metadata) : false,
        isAcknowledged: Boolean(lastAcknowledgedAt),
        lastAcknowledgedAt,
        nextSurfaceAt,
        entities: entitiesByAction.get(String(row.id)) ?? [],
        sourcePreview: sourcePreviewByAction.get(String(row.id)),
      } satisfies ActionItem;
    })
    .sort((a, b) => compareActionRows(
      { created_at: a.createdAt, metadata: { next_surface_at: a.nextSurfaceAt, last_acknowledged_at: a.lastAcknowledgedAt } },
      { created_at: b.createdAt, metadata: { next_surface_at: b.nextSurfaceAt, last_acknowledged_at: b.lastAcknowledgedAt } },
      kind,
    ));
}

async function getActionItemsByIds(ids: string[], kind: "action_open" | "action_closed"): Promise<ActionItem[]> {
  if (ids.length === 0) return [];

  const { data } = await supabase
    .from("mua_blocks")
    .select("id, content, created_at, metadata")
    .eq("block_kind", kind)
    .in("id", ids);

  return hydrateActionRows((data ?? []) as Array<Record<string, unknown>>, kind);
}

export async function getActionItemById(id: string): Promise<ActionItem | null> {
  const { data } = await supabase
    .from("mua_blocks")
    .select("id, content, created_at, metadata")
    .eq("block_kind", "action_open")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const items = await hydrateActionRows([data as Record<string, unknown>], "action_open");
  return items[0] ?? null;
}

export async function getActionsList(opts?: { closed?: boolean; limit?: number }): Promise<ActionItem[]> {
  const closed = opts?.closed ?? false;
  const limitInput = opts?.limit ?? 20;
  const limit = Number.isFinite(limitInput) && limitInput > 0 ? Math.min(limitInput, 100) : 20;
  return withBoardCache(cacheKey("actions", { closed, limit }), async () => {
    const kind = closed ? "action_closed" : "action_open";
    const queryLimit = kind === "action_open" ? Math.min(Math.max(limit * 4, 80), 160) : limit;

    const { data } = await supabase
      .from("mua_blocks")
      .select("id, content, created_at, metadata")
      .eq("block_kind", kind)
      .order("created_at", { ascending: false })
      .limit(queryLimit);

    const rows = ((data ?? []) as Array<Record<string, unknown>>)
      .sort((a, b) => compareActionRows(a, b, kind))
      .slice(0, limit);
    return hydrateActionRows(rows, kind);
  });
}

export async function getEntitiesList(opts?: { limit?: number }): Promise<EntitySummary[]> {
  const limitInput = opts?.limit ?? 30;
  const limit = Number.isFinite(limitInput) && limitInput > 0 ? Math.min(limitInput, 100) : 30;
  return withBoardCache(cacheKey("entities", { limit }), async () => {
    const { data: linksData } = await supabase
      .from("links")
      .select("to_id, from_type, from_id, metadata, link_type")
      .eq("to_type", "entity")
      .in("from_type", ["user_block", "mua_block"])
      .limit(5000);

    const blockLinks = ((linksData ?? []) as Array<Record<string, unknown>>)
      .filter((row) => !isCandidateRelatedLink(row));
    if (blockLinks.length === 0) return [];

    const entities = [...(await fetchEntitiesByIds(
      [...new Set(blockLinks.map((row) => String(row.to_id)))],
    )).values()];

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

    return entities
      .map((entity) => ({
        id: entity.id,
        name: entity.name,
        aliasCount: entity.aliases.length,
        linkedBlocks: blockIdsByEntity.get(entity.id)?.size ?? 0,
        recentBlocks: recentIdsByEntity.get(entity.id)?.size ?? 0,
      }))
      .filter((entity) => entity.linkedBlocks > 0)
      .sort((a, b) => {
        if (b.linkedBlocks !== a.linkedBlocks) return b.linkedBlocks - a.linkedBlocks;
        return b.recentBlocks - a.recentBlocks;
      })
      .slice(0, limit);
  });
}

export async function resolveEntityByName(rawName: string): Promise<EntityResolutionResult> {
  const name = rawName.trim().toLowerCase();
  if (!name) return { entity: null, matches: [] };

  const entities = await selectAllEntities(300);

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

export async function getEntityDetailById(id: string, opts?: { limit?: number }): Promise<EntityDetail | null> {
  const limitInput = opts?.limit ?? 30;
  const limit = Number.isFinite(limitInput) && limitInput > 0 ? Math.min(limitInput, 100) : 30;
  const entity = (await fetchEntitiesByIds([id])).get(id);
  if (!entity) return null;

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

  const aboutActionIds = [...new Set(links
    .filter((row) => row.from_type === "mua_block" && row.link_type === "about")
    .map((row) => String(row.from_id)))];
  const openActions = await getActionItemsByIds(aboutActionIds, "action_open");

  const timeline: TimelineEntry[] = [];
  for (const blockId of userIds) {
    const block = userBlocksById.get(blockId);
    if (!block) continue;
    timeline.push({
      id: blockId,
      type: "user_block",
      content: String(block.content ?? ""),
      createdAt: String(block.created_at ?? ""),
      source: String(block.source ?? ""),
    });
  }
  for (const blockId of muaIds) {
    const block = muaBlocksById.get(blockId);
    if (!block) continue;
    timeline.push({
      id: blockId,
      type: "mua_block",
      content: String(block.content ?? ""),
      blockKind: String(block.block_kind ?? "") || undefined,
      createdAt: String(block.created_at ?? ""),
      source: String(block.source ?? ""),
    });
  }
  timeline.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

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
    .map((entityId) => {
      const relatedEntity = relatedEntitiesById.get(entityId);
      return relatedEntity ? {
        id: relatedEntity.id,
        name: relatedEntity.name,
        sharedBlocks: relatedCounts.get(entityId)?.size ?? 0,
      } satisfies RelatedEntitySummary : null;
    })
    .filter((entry): entry is RelatedEntitySummary => entry !== null)
    .sort((a, b) => b.sharedBlocks - a.sharedBlocks)
    .slice(0, 10);

  return {
    id: entity.id,
    name: entity.name,
    aliases: entity.aliases,
    openActions,
    timeline: timeline.slice(0, limit),
    relatedEntities,
  };
}

export async function getBoardOverview(): Promise<BoardOverview> {
  return withBoardCache(cacheKey("overview"), async () => {
    const weekAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)).toISOString();
    const [userCount, noteCount, openActionsRes, closedCount, userThisWeek, muaThisWeek, topActions, topEntities, clarifications] = await Promise.all([
      supabase.from("user_blocks").select("*", { count: "exact", head: true }),
      supabase.from("mua_blocks").select("*", { count: "exact", head: true }).eq("block_kind", "note"),
      supabase.from("mua_blocks").select("id, metadata").eq("block_kind", "action_open"),
      supabase.from("mua_blocks").select("*", { count: "exact", head: true }).eq("block_kind", "action_closed"),
      supabase.from("user_blocks").select("*", { count: "exact", head: true }).gte("created_at", weekAgo),
      supabase.from("mua_blocks").select("*", { count: "exact", head: true }).gte("created_at", weekAgo),
      getActionsList({ limit: 5 }),
      getEntitiesList({ limit: 5 }),
      supabase.from("clarification_queue").select("*", { count: "exact", head: true }).in("status", ["pending", "asked"]),
    ]);

    const openActionRows = (openActionsRes.data ?? []) as Array<Record<string, unknown>>;
    const noteTotal = noteCount.count ?? 0;
    const actionOpen = openActionRows.length;
    const actionClosed = closedCount.count ?? 0;
    const byType = Object.fromEntries(
      [...openActionRows.reduce((acc, row) => {
        const type = actionTypeOf(recordOf(row.metadata)) ?? "unspecified";
        acc.set(type, (acc.get(type) ?? 0) + 1);
        return acc;
      }, new Map<string, number>()).entries()]
        .sort((a, b) => b[1] - a[1]),
    );

    return {
      blocks: {
        user: userCount.count ?? 0,
        mua: noteTotal + actionOpen + actionClosed,
        note: noteTotal,
        actionOpen,
        actionClosed,
      },
      thisWeek: (userThisWeek.count ?? 0) + (muaThisWeek.count ?? 0),
      topActions,
      topEntities,
      pendingClarifications: clarifications.count ?? 0,
      actionStats: {
        total: actionOpen,
        due: openActionRows.filter((row) => isActionDue(recordOf(row.metadata))).length,
        unacknowledged: openActionRows.filter((row) => !lastAcknowledgedAtOf(recordOf(row.metadata))).length,
        byType,
      },
    };
  });
}
