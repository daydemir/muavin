import { supabase } from "./db";
import { createUserBlock, searchRelatedBlocks, updateUserBlock, type RelatedBlock } from "./blocks";
import {
  clearPendingNoteSync,
  createDraftNoteFile,
  deleteNoteFile,
  ensureNotesDir,
  listNoteFiles,
  listPendingNoteSyncs,
  readNoteFile,
  startNotesDirWatcher,
  upsertPendingNoteSync,
  writeNoteFile,
  type NoteFile,
} from "./notes";

export interface EntityRef {
  id: string;
  name: string;
}

export interface NoteFeedItem {
  filename: string;
  id?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
  body: string;
  tags: EntityRef[];
  isSynced: boolean;
  syncError?: string;
}

export interface NoteRelatedData {
  userBlocks: RelatedBlock[];
  muaBlocks: RelatedBlock[];
  entities: EntityRef[];
}

let watcherCleanup: (() => void) | null = null;
let watcherSnapshot = new Map<string, NoteFile>();

function recordOf(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim();
}

function stripManagedFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalizeBody(normalized);
  const lines = normalized.split("\n");
  if (lines[0] !== "---") return normalizeBody(normalized);
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex < 0) return normalizeBody(normalized);
  return normalizeBody(lines.slice(closingIndex + 1).join("\n"));
}

function isCandidateRelatedLink(row: Record<string, unknown>): boolean {
  const metadata = recordOf(row.metadata);
  return String(row.link_type ?? "") === "related" && metadata.candidate_match === true;
}

function isMissingEntityNameColumn(error: unknown): boolean {
  const record = recordOf(error);
  const message = String(record.message ?? record.details ?? "");
  return String(record.code ?? "") === "42703"
    || message.includes("column entities.name does not exist");
}

function normalizeEntityRef(row: Record<string, unknown>): EntityRef {
  return {
    id: String(row.id),
    name: String(row.name ?? row.canonical_name ?? ""),
  };
}

async function selectEntityRefsByIds(ids: string[]): Promise<Map<string, EntityRef>> {
  if (ids.length === 0) return new Map();

  const primary = await supabase
    .from("entities")
    .select("id, name")
    .in("id", ids);
  if (!primary.error) {
    return new Map(
      ((primary.data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.id), normalizeEntityRef(row)]),
    );
  }
  if (!isMissingEntityNameColumn(primary.error)) throw primary.error;

  const legacy = await supabase
    .from("entities")
    .select("id, canonical_name")
    .in("id", ids);
  if (legacy.error) throw legacy.error;
  return new Map(
    ((legacy.data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.id), normalizeEntityRef(row)]),
  );
}

async function selectTagSearchRows(limit: number): Promise<Array<{ id: string; name: string; aliases: string[] }>> {
  const primary = await supabase
    .from("entities")
    .select("id, name, aliases")
    .limit(limit);
  if (!primary.error) {
    return ((primary.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ""),
      aliases: Array.isArray(row.aliases) ? row.aliases.filter((value): value is string => typeof value === "string") : [],
    }));
  }
  if (!isMissingEntityNameColumn(primary.error)) throw primary.error;

  const legacy = await supabase
    .from("entities")
    .select("id, canonical_name, aliases")
    .limit(limit);
  if (legacy.error) throw legacy.error;
  return ((legacy.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    name: String(row.canonical_name ?? ""),
    aliases: Array.isArray(row.aliases) ? row.aliases.filter((value): value is string => typeof value === "string") : [],
  }));
}

async function fetchTagsByNoteIds(noteIds: string[]): Promise<Map<string, EntityRef[]>> {
  if (noteIds.length === 0) return new Map();

  const { data: linkRows } = await supabase
    .from("links")
    .select("from_id, to_id, link_type, metadata")
    .eq("from_type", "user_block")
    .eq("to_type", "entity")
    .in("from_id", noteIds);

  const links = ((linkRows ?? []) as Array<Record<string, unknown>>)
    .filter((row) => !isCandidateRelatedLink(row));
  const entityIds = [...new Set(links.map((row) => String(row.to_id)))];
  if (entityIds.length === 0) return new Map();

  const entitiesById = await selectEntityRefsByIds(entityIds);

  const tagsByNote = new Map<string, EntityRef[]>();
  for (const link of links) {
    const noteId = String(link.from_id);
    const entity = entitiesById.get(String(link.to_id));
    if (!entity) continue;
    const tags = tagsByNote.get(noteId) ?? [];
    if (!tags.some((tag) => tag.id === entity.id)) tags.push(entity);
    tagsByNote.set(noteId, tags);
  }

  return tagsByNote;
}

async function resolveTagEntityIds(rawTag: string): Promise<Set<string>> {
  const tag = rawTag.trim().toLowerCase();
  if (!tag) return new Set();

  const ids = new Set<string>();
  for (const row of await selectTagSearchRows(1000)) {
    const name = row.name.toLowerCase();
    const aliases = row.aliases.map((alias) => alias.toLowerCase());
    if (name === tag || aliases.includes(tag)) {
      ids.add(row.id);
    }
  }
  return ids;
}

async function getPendingSyncErrorMap(): Promise<Map<string, string>> {
  const entries = await listPendingNoteSyncs();
  return new Map(
    entries
      .filter((entry) => entry.lastError)
      .map((entry) => [entry.filename, entry.lastError ?? "pending sync"]),
  );
}

async function enrichNotes(notes: NoteFile[]): Promise<NoteFeedItem[]> {
  const syncErrors = await getPendingSyncErrorMap();
  const noteIds = notes.flatMap((note) => (note.id ? [note.id] : []));
  const tagsById = await fetchTagsByNoteIds(noteIds);

  return notes.map((note) => ({
    filename: note.filename,
    id: note.id,
    title: note.title,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    preview: note.preview,
    body: note.body,
    tags: note.id ? (tagsById.get(note.id) ?? []) : [],
    isSynced: Boolean(note.id) && !syncErrors.has(note.filename),
    syncError: syncErrors.get(note.filename),
  }));
}

function noteSourceRef(filename: string) {
  return {
    type: "note_file",
    id: { filename },
  } as const;
}

async function syncUpsertNote(note: NoteFile): Promise<NoteFile> {
  const body = normalizeBody(note.body);
  if (!body) throw new Error("note content cannot be empty");

  if (!note.id) {
    const created = await createUserBlock({
      rawContent: body,
      source: "note",
      sourceRef: noteSourceRef(note.filename),
      metadata: { file_deleted: false, file_deleted_at: null },
    });
    if (created.id !== note.id) {
      const rewritten = await createOrUpdateFileId(note.filename, created.id);
      await clearPendingNoteSync(note.filename);
      return rewritten;
    }
  } else {
    await updateUserBlock({
      id: note.id,
      rawContent: body,
      source: "note",
      sourceRef: noteSourceRef(note.filename),
      metadata: { file_deleted: false, file_deleted_at: null },
      reason: "finalize",
    });
  }

  await clearPendingNoteSync(note.filename);
  return readNoteFile(note.filename);
}

async function createOrUpdateFileId(filename: string, id: string): Promise<NoteFile> {
  const existing = await readNoteFile(filename);
  return writeNoteFile({ filename, body: existing.body, id });
}

async function queueUpsertFailure(note: NoteFile, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[notes] sync upsert failed for ${note.filename}: ${message}`);
  await upsertPendingNoteSync({
    kind: "upsert",
    filename: note.filename,
    noteId: note.id,
    body: note.body,
    contentHash: note.contentHash,
    retryCount: 1,
    lastError: message,
    updatedAt: new Date().toISOString(),
  });
}

async function markNoteDeleted(note: NoteFile): Promise<void> {
  if (!note.id) {
    await clearPendingNoteSync(note.filename);
    return;
  }

  await updateUserBlock({
    id: note.id,
    rawContent: note.body,
    source: "note",
    sourceRef: noteSourceRef(note.filename),
    metadata: {
      file_deleted: true,
      file_deleted_at: new Date().toISOString(),
    },
    reason: "finalize",
  });
  await clearPendingNoteSync(note.filename);
}

async function queueDeleteFailure(note: NoteFile, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[notes] sync delete failed for ${note.filename}: ${message}`);
  await upsertPendingNoteSync({
    kind: "delete",
    filename: note.filename,
    noteId: note.id,
    body: note.body,
    contentHash: note.contentHash,
    deletedAt: new Date().toISOString(),
    retryCount: 1,
    lastError: message,
    updatedAt: new Date().toISOString(),
  });
}

async function applyUpsertWithQueue(note: NoteFile): Promise<NoteFile> {
  try {
    const synced = await syncUpsertNote(note);
    watcherSnapshot.set(synced.filename, synced);
    return synced;
  } catch (error) {
    await queueUpsertFailure(note, error);
    watcherSnapshot.set(note.filename, note);
    throw error;
  }
}

async function applyDeleteWithQueue(note: NoteFile): Promise<void> {
  try {
    await markNoteDeleted(note);
  } catch (error) {
    await queueDeleteFailure(note, error);
    throw error;
  } finally {
    watcherSnapshot.delete(note.filename);
  }
}

async function reconcileNoteMirror(): Promise<void> {
  const currentNotes = await listNoteFiles();
  const currentByFilename = new Map(currentNotes.map((note) => [note.filename, note]));
  const currentById = new Map(
    currentNotes
      .filter((note) => note.id)
      .map((note) => [note.id as string, note]),
  );

  for (const note of currentNotes) {
    const previous = watcherSnapshot.get(note.filename);
    const previousById = note.id ? [...watcherSnapshot.values()].find((item) => item.id === note.id) : undefined;
    const renamed = previousById && previousById.filename !== note.filename;
    const changed = !previous || previous.contentHash !== note.contentHash || previous.id !== note.id;

    if (!previous || changed || renamed) {
      try {
        const synced = await syncUpsertNote(note);
        currentByFilename.set(synced.filename, synced);
        if (renamed) {
          await clearPendingNoteSync(previousById!.filename);
        }
      } catch (error) {
        await queueUpsertFailure(note, error);
      }
    }
  }

  for (const previous of watcherSnapshot.values()) {
    if (currentByFilename.has(previous.filename)) continue;
    if (previous.id && currentById.has(previous.id)) continue;
    if (!previous.id) continue;
    try {
      await markNoteDeleted(previous);
    } catch (error) {
      await queueDeleteFailure(previous, error);
    }
  }

  watcherSnapshot = currentByFilename;
}

export async function flushPendingNoteSyncs(): Promise<void> {
  const entries = await listPendingNoteSyncs();
  for (const entry of entries) {
    if (entry.kind === "upsert") {
      try {
        const note = await readNoteFile(entry.filename);
        await syncUpsertNote(note);
      } catch (error) {
        await upsertPendingNoteSync({
          ...entry,
          retryCount: entry.retryCount + 1,
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
      }
      continue;
    }

    const noteFileExists = await readNoteFile(entry.filename).then(() => true).catch(() => false);
    if (noteFileExists) {
      await clearPendingNoteSync(entry.filename);
      continue;
    }
    if (!entry.noteId || !entry.body) {
      await clearPendingNoteSync(entry.filename);
      continue;
    }
    try {
      await updateUserBlock({
        id: entry.noteId,
        rawContent: entry.body,
        source: "note",
        sourceRef: noteSourceRef(entry.filename),
        metadata: {
          file_deleted: true,
          file_deleted_at: entry.deletedAt ?? new Date().toISOString(),
        },
        reason: "finalize",
      });
      await clearPendingNoteSync(entry.filename);
    } catch (error) {
      await upsertPendingNoteSync({
        ...entry,
        retryCount: entry.retryCount + 1,
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

export async function startNotesWatcher(): Promise<() => void> {
  if (watcherCleanup) return watcherCleanup;
  await ensureNotesDir();
  watcherSnapshot = new Map();
  await reconcileNoteMirror();
  await flushPendingNoteSyncs();
  watcherCleanup = await startNotesDirWatcher(async () => {
    await reconcileNoteMirror();
    await flushPendingNoteSyncs();
  });
  return watcherCleanup;
}

export async function getNotesFeed(opts?: {
  offset?: number;
  limit?: number;
  tag?: string;
}): Promise<{ items: NoteFeedItem[]; hasMore: boolean; nextOffset: number | null }> {
  const offset = Math.max(0, opts?.offset ?? 0);
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 100));
  const notes = await listNoteFiles();
  const enriched = await enrichNotes(notes);

  let filtered = enriched;
  if (opts?.tag) {
    const matchedEntityIds = await resolveTagEntityIds(opts.tag);
    filtered = matchedEntityIds.size === 0
      ? []
      : enriched.filter((note) => note.tags.some((tag) => matchedEntityIds.has(tag.id)));
  }

  const slice = filtered.slice(offset, offset + limit);
  return {
    items: slice,
    hasMore: offset + limit < filtered.length,
    nextOffset: offset + limit < filtered.length ? offset + limit : null,
  };
}

export async function getNoteByFilename(filename: string): Promise<NoteFeedItem | null> {
  const note = await readNoteFile(filename).catch(() => null);
  if (!note) return null;
  const [item] = await enrichNotes([note]);
  return item ?? null;
}

export async function createNote(input: { content: string }): Promise<NoteFeedItem> {
  const body = stripManagedFrontmatter(input.content);
  if (!body) throw new Error("note content cannot be empty");
  const note = await createDraftNoteFile(body);
  const synced = await applyUpsertWithQueue(note).catch(() => note);
  const item = await getNoteByFilename(synced.filename);
  if (!item) throw new Error("created note could not be read back");
  return item;
}

export async function saveNote(input: { filename: string; content: string }): Promise<NoteFeedItem> {
  const body = stripManagedFrontmatter(input.content);
  if (!body) throw new Error("note content cannot be empty");

  const existing = await readNoteFile(input.filename);
  const written = await writeNoteFile({
    filename: input.filename,
    body,
    id: existing.id,
  });

  const synced = await applyUpsertWithQueue(written).catch(() => written);
  const item = await getNoteByFilename(synced.filename);
  if (!item) throw new Error("saved note could not be read back");
  return item;
}

export async function createCliDraftNote(): Promise<NoteFile> {
  return createDraftNoteFile("");
}

export async function finalizeCliDraftNote(filename: string): Promise<NoteFeedItem | null> {
  const note = await readNoteFile(filename).catch(() => null);
  if (!note) return null;
  if (!normalizeBody(note.body)) {
    await deleteNoteFile(filename).catch(() => {});
    watcherSnapshot.delete(filename);
    return null;
  }

  const synced = await applyUpsertWithQueue(note).catch(() => note);
  return getNoteByFilename(synced.filename);
}

export async function getNoteRelated(filename: string): Promise<NoteRelatedData | null> {
  const note = await getNoteByFilename(filename);
  if (!note) return null;

  const related = normalizeBody(note.body)
    ? await searchRelatedBlocks({ query: note.body, scope: "all", limit: 8 })
    : [];

  let entities: EntityRef[] = [];
  if (note.id) {
    const { data } = await supabase
      .from("links")
      .select("to_id")
      .eq("from_type", "user_block")
      .eq("from_id", note.id)
      .eq("to_type", "entity");

    const entityIds = [...new Set(((data ?? []) as Array<Record<string, unknown>>).map((row) => String(row.to_id)))];
    if (entityIds.length > 0) {
      entities = [...(await selectEntityRefsByIds(entityIds)).values()];
    }
  }

  return {
    userBlocks: related.filter((row) => row.authorType === "user"),
    muaBlocks: related.filter((row) => row.authorType === "mua"),
    entities,
  };
}

export async function getCliNoteList(opts?: { limit?: number; tag?: string }): Promise<NoteFeedItem[]> {
  const feed = await getNotesFeed({ offset: 0, limit: opts?.limit ?? 20, tag: opts?.tag });
  return feed.items;
}

export async function getWorkspaceSelection(filename: string): Promise<NoteFeedItem | null> {
  return getNoteByFilename(filename);
}
