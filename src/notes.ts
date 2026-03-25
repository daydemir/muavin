import { watch, type FSWatcher } from "fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { MUAVIN_DIR, loadJson, saveJson } from "./utils";

export const NOTES_DIR = join(MUAVIN_DIR, "notes");
export const NOTES_SYNC_QUEUE_PATH = join(MUAVIN_DIR, "notes-sync-queue.json");

const NOTE_EXTENSION = ".md";
const NOTE_FILENAME_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)\.md$/;

export interface NoteFile {
  filename: string;
  path: string;
  id?: string;
  title: string;
  body: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
}

export interface PendingNoteSyncEntry {
  kind: "upsert" | "delete";
  filename: string;
  noteId?: string;
  body?: string;
  contentHash?: string;
  deletedAt?: string;
  retryCount: number;
  lastError?: string;
  updatedAt: string;
}

function parseScalar(value: string): string {
  return value.trim();
}

function parseFrontmatter(raw: string): { id?: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { body: normalized.trim() };
  const lines = normalized.split("\n");
  if (lines[0] !== "---") return { body: normalized.trim() };

  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex < 0) return { body: normalized.trim() };

  const frontmatter = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n").trim();
  let id: string | undefined;

  for (const line of frontmatter.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = parseScalar(line.slice(idx + 1));
    if (key === "id" && value) id = value;
  }

  return { id, body };
}

function renderFrontmatter(id: string | undefined): string {
  return `---\nid: ${id ?? ""}\n---`;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim();
}

function makePreview(body: string, maxLength = 220): string {
  const lines = normalizeBody(body)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  const preview = lines.join("\n");
  if (preview.length <= maxLength) return preview;
  return `${preview.slice(0, maxLength - 1)}…`;
}

function titleFromBody(body: string): string | null {
  const firstLine = normalizeBody(body)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;

  const headingMatch = firstLine.match(/^#{1,6}\s+(.*)$/);
  const title = (headingMatch?.[1] ?? firstLine).trim();
  if (!title) return null;
  return title.length <= 120 ? title : `${title.slice(0, 119)}…`;
}

function filenameTitle(filename: string): string {
  const stem = filename.replace(/\.md$/i, "");
  const match = stem.match(NOTE_FILENAME_RE);
  const raw = match?.[7] ?? stem;
  const words = raw
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "Untitled";
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function makeTitle(filename: string, body: string): string {
  return titleFromBody(body) ?? filenameTitle(filename);
}

function slugify(content: string): string {
  const normalized = normalizeBody(content)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "note").slice(0, 40).replace(/-+$/g, "") || "note";
}

function formatFilenameTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function parseFilenameTimestamp(filename: string): string {
  const match = filename.match(NOTE_FILENAME_RE);
  if (!match) return new Date(0).toISOString();
  const [, year, month, day, hour, minute, second] = match;
  const localDate = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return localDate.toISOString();
}

async function hashText(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(digest).toString("hex");
}

export function isNoteFilename(filename: string): boolean {
  return NOTE_FILENAME_RE.test(filename);
}

export function notePath(filename: string): string {
  return join(NOTES_DIR, filename);
}

export async function ensureNotesDir(): Promise<void> {
  await mkdir(NOTES_DIR, { recursive: true });
}

export async function parseNoteAtPath(path: string, filename: string): Promise<NoteFile> {
  const raw = await readFile(path, "utf-8");
  const parsed = parseFrontmatter(raw);
  const stats = await stat(path);
  const body = normalizeBody(parsed.body);
  return {
    filename,
    path,
    id: parsed.id,
    title: makeTitle(filename, body),
    body,
    preview: makePreview(body),
    createdAt: parseFilenameTimestamp(filename),
    updatedAt: stats.mtime.toISOString(),
    contentHash: await hashText(body),
  };
}

export async function readNoteFile(filename: string): Promise<NoteFile> {
  if (!isNoteFilename(filename)) {
    throw new Error(`invalid note filename: ${filename}`);
  }
  return parseNoteAtPath(notePath(filename), filename);
}

export async function listNoteFiles(): Promise<NoteFile[]> {
  await ensureNotesDir();
  const filenames = (await readdir(NOTES_DIR))
    .filter((filename) => isNoteFilename(filename))
    .sort((a, b) => b.localeCompare(a));

  const notes = await Promise.all(
    filenames.map(async (filename) => {
      try {
        return await parseNoteAtPath(notePath(filename), filename);
      } catch {
        return null;
      }
    }),
  );
  return notes.filter((note): note is NoteFile => note !== null);
}

export async function writeNoteFile(input: {
  filename: string;
  body: string;
  id?: string;
}): Promise<NoteFile> {
  await ensureNotesDir();
  const body = normalizeBody(input.body);
  const path = notePath(input.filename);
  const tmpPath = `${path}.tmp`;
  const content = `${renderFrontmatter(input.id)}\n\n${body}${body ? "\n" : ""}`;
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, path);
  return readNoteFile(input.filename);
}

export async function deleteNoteFile(filename: string): Promise<void> {
  await unlink(notePath(filename));
}

export async function createDraftNoteFile(initialBody = ""): Promise<NoteFile> {
  await ensureNotesDir();
  const now = new Date();
  let filename = `${formatFilenameTimestamp(now)}-${slugify(initialBody)}${NOTE_EXTENSION}`;
  let attempt = 1;

  while (true) {
    try {
      await stat(notePath(filename));
      attempt += 1;
      filename = `${formatFilenameTimestamp(now)}-${slugify(initialBody)}-${attempt}${NOTE_EXTENSION}`;
    } catch {
      break;
    }
  }

  return writeNoteFile({ filename, body: initialBody });
}

type PendingNoteSyncMap = Record<string, PendingNoteSyncEntry>;

async function loadPendingNoteSyncMap(): Promise<PendingNoteSyncMap> {
  return (await loadJson<PendingNoteSyncMap>(NOTES_SYNC_QUEUE_PATH)) ?? {};
}

async function savePendingNoteSyncMap(map: PendingNoteSyncMap): Promise<void> {
  const entries = Object.keys(map);
  if (entries.length === 0) {
    await unlink(NOTES_SYNC_QUEUE_PATH).catch(() => {});
    return;
  }
  await saveJson(NOTES_SYNC_QUEUE_PATH, map);
}

export async function listPendingNoteSyncs(): Promise<PendingNoteSyncEntry[]> {
  const map = await loadPendingNoteSyncMap();
  return Object.values(map).sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function upsertPendingNoteSync(entry: PendingNoteSyncEntry): Promise<void> {
  const map = await loadPendingNoteSyncMap();
  map[entry.filename] = entry;
  await savePendingNoteSyncMap(map);
}

export async function clearPendingNoteSync(filename: string): Promise<void> {
  const map = await loadPendingNoteSyncMap();
  delete map[filename];
  await savePendingNoteSyncMap(map);
}

export async function startNotesDirWatcher(onChange: () => Promise<void> | void, debounceMs = 2000): Promise<() => void> {
  await ensureNotesDir();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      Promise.resolve(onChange()).catch((error) => {
        console.error("[notes] watcher reconcile failed:", error);
      });
    }, debounceMs);
  };

  const watcher: FSWatcher = watch(NOTES_DIR, () => run());
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
