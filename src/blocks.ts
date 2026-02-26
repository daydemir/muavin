import { readdir, readFile, stat, mkdir, unlink } from "fs/promises";
import { join, extname, basename } from "path";
import { homedir, tmpdir } from "os";
import { spawn } from "bun";
import { embed, getActiveEmbeddingProfileId, supabase, upsertBlockEmbedding } from "./db";
import { loadConfig } from "./utils";
import { callClaude } from "./claude";

export type BlockVisibility = "private" | "public";
export type BlockSource =
  | "chat"
  | "cli"
  | "email"
  | "note"
  | "reminder"
  | "file"
  | "api"
  | "import"
  | "system"
  | "job"
  | "agent";
export type BlockScope = "user" | "all";

export interface RelatedBlock {
  id: string;
  authorType: "user" | "mua";
  content: string;
  createdAt: string;
  source: string;
  blockKind: string | null;
  lexicalScore: number;
  vectorScore: number;
  score: number;
}

interface FrontmatterParseResult {
  body: string;
  metadata: Record<string, unknown>;
}

interface BlockInsertResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

interface ClarificationOption {
  value: string;
  label: string;
}

interface ClarificationQueueRow {
  id: string;
  question: string;
  options: ClarificationOption[];
  context: Record<string, unknown>;
  status: "pending" | "asked" | "answered" | "expired";
}

interface EntityRow {
  id: string;
  canonical_name: string;
  aliases: string[];
  entity_type: string;
  verified: boolean;
}

interface ProcessorMuaBlockDraft {
  content: string;
  block_kind?: "note" | "action_open" | "action_closed";
  confidence?: number;
}

interface BlockProcessResult {
  analysis: string;
  mua_blocks: ProcessorMuaBlockDraft[];
  related_block_ids: string[];
  entity_names: string[];
}

interface ArtifactProcessResult {
  description: string;
  mua_blocks: ProcessorMuaBlockDraft[];
  entity_names: string[];
}

export interface ProcessPendingStateResult {
  userScanned: number;
  userProcessed: number;
  userErrored: number;
  artifactsScanned: number;
  artifactsProcessed: number;
  artifactsErrored: number;
}

export interface CrmTimelineItem {
  at: string;
  content: string;
  authorType: "user" | "mua";
  source: string;
}

export interface CrmPersonSummary {
  entityId: string;
  name: string;
  verified: boolean;
  lastContactAt: string | null;
  daysSinceContact: number | null;
  openLoops: number;
  roiScore: number;
  recentTopics: string[];
  timeline: CrmTimelineItem[];
}

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".rtf", ".json", ".csv", ".yaml", ".yml", ".xml", ".html", ".js", ".ts", ".py",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const MAX_EXTRACTED_TEXT = 200_000;
const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe";
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";
const SYSTEM_CWD = join(homedir(), ".muavin", "system");
const PROCESSOR_VERSION = "v1";
const USER_VERSION_CHECKPOINT_MS = 60_000;

const BLOCK_PROCESS_SCHEMA = {
  type: "object",
  properties: {
    analysis: { type: "string" },
    mua_blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          block_kind: { type: "string", enum: ["note", "action_open", "action_closed"] },
          confidence: { type: "number" },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
    related_block_ids: { type: "array", items: { type: "string" } },
    entity_names: { type: "array", items: { type: "string" } },
  },
  required: ["analysis", "mua_blocks", "related_block_ids", "entity_names"],
  additionalProperties: false,
} as const;

const ARTIFACT_PROCESS_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    mua_blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          block_kind: { type: "string", enum: ["note", "action_open", "action_closed"] },
          confidence: { type: "number" },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
    entity_names: { type: "array", items: { type: "string" } },
  },
  required: ["description", "mua_blocks", "entity_names"],
  additionalProperties: false,
} as const;

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function toTopicTokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);

  const stop = new Set([
    "this", "that", "with", "from", "have", "will", "would", "there", "their", "about", "email", "draft", "note",
    "what", "when", "where", "should", "could", "also", "into", "over", "under", "only", "them", "they", "your",
  ]);

  const counts = new Map<string, number>();
  for (const word of words) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parseFrontmatter(raw: string): FrontmatterParseResult {
  if (!raw.startsWith("---\n")) return { body: raw.trim(), metadata: {} };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { body: raw.trim(), metadata: {} };

  const fm = raw.slice(4, end);
  const body = raw.slice(end + 5).trim();
  const metadata: Record<string, unknown> = {};

  for (const line of fm.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (!key) continue;
    metadata[key] = parseScalar(value);
  }

  return { body, metadata };
}

function metadataRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

interface SourceRefEnvelope {
  [key: string]: unknown;
  v: number;
  type: string;
  id: Record<string, unknown>;
  extras: Record<string, unknown>;
}

function sourceRefTypeFor(channel: BlockSource): string {
  switch (channel) {
    case "chat":
      return "telegram_message";
    case "file":
      return "artifact";
    case "cli":
      return "cli_input";
    case "job":
      return "job_run";
    case "agent":
      return "agent_run";
    case "import":
      return "import_batch";
    default:
      return "external_object";
  }
}

function normalizeSourceRef(channel: BlockSource, sourceRef?: Record<string, unknown>): SourceRefEnvelope {
  const input = metadataRecord(sourceRef);
  const id = metadataRecord(input.id);
  const extras = metadataRecord(input.extras);
  const explicitType = typeof input.type === "string" ? input.type : sourceRefTypeFor(channel);
  return {
    v: typeof input.v === "number" ? input.v : 1,
    type: explicitType,
    id: Object.keys(id).length > 0 ? id : input,
    extras,
  };
}

async function hashText(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(digest).toString("hex");
}

async function queueProcessingState(subjectType: "user_block" | "artifact", subjectId: string, inputHash: string): Promise<void> {
  const now = new Date().toISOString();
  const { data: existing } = await supabase
    .from("processing_state")
    .select("state, last_processed_hash")
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .maybeSingle();
  if (existing) {
    const row = existing as { state: string | null; last_processed_hash: string | null };
    if (row.state === "processed" && row.last_processed_hash === inputHash) return;
  }

  await supabase
    .from("processing_state")
    .upsert({
      subject_type: subjectType,
      subject_id: subjectId,
      input_hash: inputHash,
      state: "pending",
      last_error: null,
      updated_at: now,
    }, { onConflict: "subject_type,subject_id" });
}

async function appendUserBlockVersion(input: {
  blockId: string;
  content: string;
  source: BlockSource;
  sourceRef: Record<string, unknown>;
  metadata: Record<string, unknown>;
  reason: "create" | "autosave" | "finalize";
}): Promise<void> {
  const contentHash = await hashText(input.content);
  const { data: latest } = await supabase
    .from("user_block_versions")
    .select("version_no")
    .eq("block_id", input.blockId)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  const versionNo = latest ? Number((latest as { version_no: number }).version_no) + 1 : 1;

  await supabase.from("user_block_versions").insert({
    block_id: input.blockId,
    version_no: versionNo,
    content: input.content,
    content_hash: contentHash,
    source: input.source,
    source_ref: input.sourceRef,
    metadata: input.metadata,
    capture_reason: input.reason,
  });
}

async function maybeCheckpointUserBlockVersion(input: {
  blockId: string;
  content: string;
  source: BlockSource;
  sourceRef: Record<string, unknown>;
  metadata: Record<string, unknown>;
  reason: "autosave" | "finalize";
}): Promise<void> {
  const contentHash = await hashText(input.content);
  const { data: latest } = await supabase
    .from("user_block_versions")
    .select("content_hash, captured_at")
    .eq("block_id", input.blockId)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest) {
    await appendUserBlockVersion({ ...input, reason: "create" });
    return;
  }

  const lastHash = String((latest as { content_hash: string }).content_hash);
  const lastCapturedAt = new Date(String((latest as { captured_at: string }).captured_at)).getTime();
  if (contentHash === lastHash) return;
  if (input.reason === "autosave" && (Date.now() - lastCapturedAt) < USER_VERSION_CHECKPOINT_MS) return;

  await appendUserBlockVersion(input);
}

function normalizeEntityName(name: string): string {
  return normalizeWhitespace(name)
    .split(/\s+/)
    .map((w) => (w.length > 1 ? `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}` : w.toUpperCase()))
    .join(" ");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fileMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain";
  if (IMAGE_EXTENSIONS.has(ext)) return `image/${ext.slice(1)}`;
  if (AUDIO_EXTENSIONS.has(ext)) return `audio/${ext.slice(1)}`;
  if (VIDEO_EXTENSIONS.has(ext)) return `video/${ext.slice(1)}`;
  return "application/octet-stream";
}

async function computeSha256(path: string): Promise<string> {
  const bytes = await Bun.file(path).bytes();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Buffer.from(digest).toString("hex");
  return hash;
}

async function commandExists(cmd: string): Promise<boolean> {
  const proc = spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return proc.exitCode === 0;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

interface R2Config {
  bucket: string;
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

function getR2Config(): R2Config {
  return {
    bucket: requiredEnv("R2_BUCKET"),
    endpoint: requiredEnv("R2_ENDPOINT_URL"),
    accessKey: requiredEnv("R2_ACCESS_KEY_ID"),
    secretKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    region: process.env.R2_REGION ?? "auto",
  };
}

function tokenizeQuery(query: string): string[] {
  return normalizeWhitespace(query)
    .toLowerCase()
    .split(" ")
    .filter((t) => t.length >= 2)
    .slice(0, 6);
}

function escapeIlike(value: string): string {
  return value.replace(/[%_]/g, " ");
}

async function findPersonEntities(name: string): Promise<EntityRow[]> {
  const { data, error } = await supabase
    .from("entities")
    .select("id, canonical_name, aliases, entity_type, verified")
    .eq("entity_type", "person")
    .limit(200);

  if (error || !data) return [];
  const lowered = name.toLowerCase();
  return (data as EntityRow[])
    .filter((r) => {
      if (r.canonical_name.toLowerCase().includes(lowered)) return true;
      return (r.aliases ?? []).some((a) => a.toLowerCase().includes(lowered));
    })
    .slice(0, 10);
}

async function findPersonEntitiesLoose(name: string): Promise<EntityRow[]> {
  const lowered = name.toLowerCase();
  const { data, error } = await supabase
    .from("entities")
    .select("id, canonical_name, aliases, entity_type, verified")
    .eq("entity_type", "person")
    .limit(200);

  if (error || !data) return [];
  const rows = data as EntityRow[];
  return rows.filter((r) => {
    if (r.canonical_name.toLowerCase().includes(lowered)) return true;
    return (r.aliases ?? []).some((a) => a.toLowerCase().includes(lowered));
  });
}

async function createEntityCandidate(name: string, confidence: number): Promise<string | null> {
  const canonicalName = name
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  const { data, error } = await supabase
    .from("entities")
    .insert({
      entity_type: "person",
      canonical_name: canonicalName,
      aliases: [name],
      confidence,
      verified: false,
      metadata: { origin: "auto_candidate" },
    })
    .select("id")
    .single();

  if (error || !data) return null;
  return (data as { id: string }).id;
}

async function ensurePersonEntity(name: string, confidence: number): Promise<EntityRow | null> {
  const cleaned = normalizeWhitespace(name);
  if (!cleaned) return null;

  const normalized = normalizeEntityName(cleaned);
  const lowered = normalized.toLowerCase();
  const matches = await findPersonEntitiesLoose(normalized);
  if (matches.length > 0) {
    const exact = matches.find((m) => {
      if (m.canonical_name.toLowerCase() === lowered) return true;
      return (m.aliases ?? []).some((a) => a.toLowerCase() === lowered);
    }) ?? matches[0];

    const aliases = new Set<string>(exact.aliases ?? []);
    aliases.add(normalized);
    await supabase
      .from("entities")
      .update({
        aliases: [...aliases].slice(0, 32),
        updated_at: new Date().toISOString(),
      })
      .eq("id", exact.id);
    return {
      ...exact,
      aliases: [...aliases].slice(0, 32),
    };
  }

  const id = await createEntityCandidate(normalized, confidence);
  if (!id) return null;
  return {
    id,
    canonical_name: normalized,
    aliases: [normalized],
    entity_type: "person",
    verified: false,
  };
}

async function insertLink(input: {
  fromType: "user_block" | "mua_block" | "entity" | "artifact";
  fromId: string;
  toType: "user_block" | "mua_block" | "entity" | "artifact";
  toId: string;
  linkType: "references" | "about" | "derived_from" | "related" | "supersedes" | "mentions" | "candidate_match";
  confidence?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { data: existing } = await supabase
    .from("links")
    .select("id")
    .eq("from_type", input.fromType)
    .eq("from_id", input.fromId)
    .eq("to_type", input.toType)
    .eq("to_id", input.toId)
    .eq("link_type", input.linkType)
    .limit(1);
  if ((existing?.length ?? 0) > 0) return;

  await supabase.from("links").insert({
    from_type: input.fromType,
    from_id: input.fromId,
    to_type: input.toType,
    to_id: input.toId,
    link_type: input.linkType,
    confidence: input.confidence ?? null,
    metadata: input.metadata ?? {},
  });
}

async function queueClarification(input: {
  question: string;
  options: ClarificationOption[];
  context: Record<string, unknown>;
  priority?: "low" | "normal" | "high";
}): Promise<string | null> {
  const { data, error } = await supabase
    .from("clarification_queue")
    .insert({
      question: input.question,
      options: input.options,
      context: input.context,
      priority: input.priority ?? "normal",
      status: "pending",
    })
    .select("id")
    .single();

  if (error || !data) return null;
  return (data as { id: string }).id;
}

function extractEmailTarget(content: string): string | null {
  const match = content.match(/\bemail\s+([a-z][a-z]+(?:\s+[a-z][a-z]+)?)/i);
  if (!match) return null;
  return normalizeWhitespace(match[1]);
}

async function createMuaQuestionBlock(question: string, context: Record<string, unknown>): Promise<void> {
  await supabase.from("mua_blocks").insert({
    content: question,
    visibility: "private",
    source: "system",
    source_ref: normalizeSourceRef("system"),
    metadata: { kind: "clarification", ...context },
    block_kind: "action_open",
    confidence: 0.5,
  });
}

async function maybeQueueEntityDisambiguation(blockId: string, content: string): Promise<void> {
  const target = extractEmailTarget(content);
  if (!target) return;

  const matches = await findPersonEntitiesLoose(target);
  if (matches.length === 1) {
    await insertLink({
      fromType: "user_block",
      fromId: blockId,
      toType: "entity",
      toId: matches[0].id,
      linkType: "about",
      confidence: 0.9,
      metadata: { trigger: "email_target" },
    });
    return;
  }

  if (matches.length > 1) {
    const opts: ClarificationOption[] = matches.map((m) => ({
      label: `${m.canonical_name}${m.verified ? " (verified)" : ""}`,
      value: `entity:${m.id}`,
    }));
    opts.push({ label: `new person: ${target}`, value: `new:${target}` });
    opts.push({ label: "none of these", value: "dismiss" });

    const q = `for "email ${target}", which person did you mean?`;
    const clarificationId = await queueClarification({
      question: q,
      options: opts,
      context: {
        type: "person_disambiguation",
        mention: target,
        blockId,
        candidateEntityIds: matches.map((m) => m.id),
      },
      priority: "high",
    });

    if (clarificationId) {
      await createMuaQuestionBlock(q, { clarificationId, blockId, mention: target });
    }
    return;
  }

  const candidateId = await createEntityCandidate(target, 0.55);
  if (!candidateId) return;

  await insertLink({
    fromType: "user_block",
    fromId: blockId,
    toType: "entity",
    toId: candidateId,
    linkType: "candidate_match",
    confidence: 0.55,
    metadata: { trigger: "email_target", mention: target },
  });

  const q = `you wrote "email ${target}". should i treat ${target} as a new person?`;
  const clarificationId = await queueClarification({
    question: q,
    options: [
      { label: `yes, create ${target}`, value: `confirm_new:${candidateId}` },
      { label: "no, ignore this", value: "dismiss" },
    ],
    context: {
      type: "person_new_confirm",
      mention: target,
      blockId,
      candidateEntityId: candidateId,
    },
    priority: "normal",
  });

  if (clarificationId) {
    await createMuaQuestionBlock(q, { clarificationId, blockId, mention: target, candidateEntityId: candidateId });
  }
}

export async function createUserBlock(input: {
  rawContent: string;
  visibility?: BlockVisibility;
  source?: BlockSource;
  sourceRef?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<BlockInsertResult> {
  const parsed = parseFrontmatter(input.rawContent);
  const body = parsed.body;
  if (!body) throw new Error("Block content cannot be empty");

  const source = input.source ?? "cli";
  const sourceRef = normalizeSourceRef(source, input.sourceRef);
  const metadata = {
    ...parsed.metadata,
    ...(input.metadata ?? {}),
  };
  const inputHash = await hashText(body);

  const { data, error } = await supabase
    .from("user_blocks")
    .insert({
      content: body,
      visibility: input.visibility ?? "private",
      source,
      source_ref: sourceRef,
      metadata,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`createUserBlock failed: ${error?.message ?? "unknown error"}`);
  }

  const id = (data as { id: string }).id;
  await appendUserBlockVersion({
    blockId: id,
    content: body,
    source,
    sourceRef,
    metadata,
    reason: "create",
  }).catch(() => {});
  await queueProcessingState("user_block", id, inputHash).catch(() => {});
  await upsertBlockEmbedding({ blockType: "user", blockId: id, text: body }).catch(() => {});
  await maybeQueueEntityDisambiguation(id, body).catch(() => {});
  return { id, content: body, metadata };
}

export async function updateUserBlock(input: {
  id: string;
  rawContent: string;
  source?: BlockSource;
  sourceRef?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  reason?: "autosave" | "finalize";
}): Promise<BlockInsertResult> {
  const parsed = parseFrontmatter(input.rawContent);
  const body = parsed.body;
  if (!body) throw new Error("Block content cannot be empty");

  const { data: existingRow, error: existingError } = await supabase
    .from("user_blocks")
    .select("id, metadata, source_ref, source")
    .eq("id", input.id)
    .single();
  if (existingError || !existingRow) {
    throw new Error(`updateUserBlock failed: block ${input.id} not found`);
  }

  const existingSource = String((existingRow as { source?: string }).source ?? "cli") as BlockSource;
  const source = input.source ?? existingSource;
  const sourceRef = normalizeSourceRef(source, input.sourceRef ?? metadataRecord((existingRow as { source_ref?: unknown }).source_ref));
  const existingMetadata = metadataRecord((existingRow as { metadata: unknown }).metadata);
  const metadata = {
    ...existingMetadata,
    ...parsed.metadata,
    ...(input.metadata ?? {}),
  };
  const inputHash = await hashText(body);

  const { data, error } = await supabase
    .from("user_blocks")
    .update({
      content: body,
      metadata,
      source,
      source_ref: sourceRef,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`updateUserBlock failed: ${error?.message ?? "unknown error"}`);
  }

  await maybeCheckpointUserBlockVersion({
    blockId: input.id,
    content: body,
    source,
    sourceRef,
    metadata,
    reason: input.reason ?? "autosave",
  }).catch(() => {});
  await queueProcessingState("user_block", input.id, inputHash).catch(() => {});
  await upsertBlockEmbedding({ blockType: "user", blockId: input.id, text: body }).catch(() => {});
  await maybeQueueEntityDisambiguation(input.id, body).catch(() => {});
  return { id: (data as { id: string }).id, content: body, metadata };
}

export async function createMuaBlock(input: {
  content: string;
  blockKind?: "note" | "action_open" | "action_closed";
  confidence?: number;
  visibility?: BlockVisibility;
  source?: BlockSource;
  sourceRef?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}): Promise<BlockInsertResult> {
  if (!input.content.trim()) throw new Error("MUA block content cannot be empty");
  if (input.dedupeKey) {
    const { data: existing } = await supabase
      .from("mua_blocks")
      .select("id, content, metadata")
      .eq("dedupe_key", input.dedupeKey)
      .limit(1)
      .maybeSingle();
    if (existing) {
      const row = existing as { id: string; content: string; metadata: Record<string, unknown> };
      return { id: row.id, content: row.content, metadata: row.metadata ?? {} };
    }
  }

  const source = input.source ?? "system";
  const sourceRef = normalizeSourceRef(source, input.sourceRef);

  const { data, error } = await supabase
    .from("mua_blocks")
    .insert({
      content: input.content,
      block_kind: input.blockKind ?? "note",
      confidence: input.confidence ?? null,
      visibility: input.visibility ?? "private",
      source,
      source_ref: sourceRef,
      metadata: input.metadata ?? {},
      dedupe_key: input.dedupeKey ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`createMuaBlock failed: ${error?.message ?? "unknown error"}`);
  }

  const id = (data as { id: string }).id;
  await upsertBlockEmbedding({ blockType: "mua", blockId: id, text: input.content }).catch(() => {});
  return { id, content: input.content, metadata: input.metadata ?? {} };
}

export async function searchRelatedBlocks(input: {
  query: string;
  scope: BlockScope;
  limit?: number;
  offset?: number;
}): Promise<RelatedBlock[]> {
  const limit = input.limit ?? 8;
  const offset = input.offset ?? 0;
  const includeUser = true;
  const includeMua = input.scope === "all";

  const lexicalMap = new Map<string, RelatedBlock>();
  const queryTokens = tokenizeQuery(input.query);

  if (queryTokens.length > 0) {
    let lexicalQuery = supabase
      .from("all_blocks_v")
      .select("id, author_type, content, created_at, source, block_kind")
      .order("created_at", { ascending: false })
      .limit(limit * 8);

    if (!includeMua) lexicalQuery = lexicalQuery.eq("author_type", "user");

    const ors = queryTokens.map((tok) => `content.ilike.%${escapeIlike(tok)}%`);
    lexicalQuery = lexicalQuery.or(ors.join(","));

    const { data } = await lexicalQuery;
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = `${row.author_type}:${row.id}`;
      const content = String(row.content ?? "");
      let score = 0;
      for (const tok of queryTokens) {
        if (content.toLowerCase().includes(tok)) score += 0.25;
      }

      lexicalMap.set(key, {
        id: String(row.id),
        authorType: row.author_type === "mua" ? "mua" : "user",
        content,
        createdAt: String(row.created_at),
        source: String(row.source ?? ""),
        blockKind: row.block_kind ? String(row.block_kind) : null,
        lexicalScore: Math.min(score, 1),
        vectorScore: 0,
        score: Math.min(score, 1),
      });
    }
  }

  const vectorMap = new Map<string, RelatedBlock>();
  try {
    const emb = await embed(input.query);
    const profileId = await getActiveEmbeddingProfileId();
    const { data } = await supabase.rpc("search_all_blocks", {
      query_embedding: emb,
      profile_id: profileId,
      include_user: includeUser,
      include_mua: includeMua,
      match_threshold: 0.68,
      match_count: limit * 8,
    });

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = `${row.author_type}:${row.id}`;
      vectorMap.set(key, {
        id: String(row.id),
        authorType: row.author_type === "mua" ? "mua" : "user",
        content: String(row.content ?? ""),
        createdAt: String(row.created_at),
        source: String(row.source ?? ""),
        blockKind: row.block_kind ? String(row.block_kind) : null,
        lexicalScore: 0,
        vectorScore: Number(row.similarity ?? 0),
        score: Number(row.similarity ?? 0),
      });
    }
  } catch {
    // RPC missing or temporary DB issue: lexical results still work.
  }

  const merged = new Map<string, RelatedBlock>();
  for (const [k, row] of lexicalMap) merged.set(k, row);
  for (const [k, row] of vectorMap) {
    const existing = merged.get(k);
    if (!existing) {
      merged.set(k, row);
      continue;
    }
    existing.vectorScore = row.vectorScore;
    existing.score = existing.lexicalScore * 0.45 + existing.vectorScore * 0.55;
  }

  const ranked = [...merged.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  return ranked.slice(offset, offset + limit);
}

export async function getPendingClarifications(limit = 20): Promise<ClarificationQueueRow[]> {
  const { data, error } = await supabase
    .from("clarification_queue")
    .select("id, question, options, context, status")
    .in("status", ["pending", "asked"])
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !data) return [];

  return (data as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    question: String(row.question),
    options: (row.options as ClarificationOption[]) ?? [],
    context: (row.context as Record<string, unknown>) ?? {},
    status: (row.status as ClarificationQueueRow["status"]) ?? "pending",
  }));
}

export async function buildClarificationDigest(limit = 20): Promise<string | null> {
  const items = await getPendingClarifications(limit);
  if (items.length === 0) return null;

  const lines: string[] = [
    "overnight clarification digest",
    "answer in CLI: bun muavin clarify answer --id <id> --option <number>",
    "",
  ];

  for (const item of items) {
    lines.push(`${item.id}`);
    lines.push(`q: ${item.question}`);
    item.options.forEach((opt, idx) => {
      lines.push(`  ${idx + 1}. ${opt.label}`);
    });
    lines.push("");
  }

  const ids = items.map((i) => i.id);
  await supabase
    .from("clarification_queue")
    .update({ status: "asked", asked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in("id", ids)
    .in("status", ["pending", "asked"]);

  return lines.join("\n").trim();
}

export async function resolveClarification(input: { id: string; optionIndex: number }): Promise<{ ok: boolean; message: string }> {
  const { data, error } = await supabase
    .from("clarification_queue")
    .select("id, question, options, context, status")
    .eq("id", input.id)
    .single();

  if (error || !data) return { ok: false, message: "clarification id not found" };

  const row = data as ClarificationQueueRow;
  if (row.status === "answered") return { ok: false, message: "clarification already answered" };
  if (input.optionIndex < 1 || input.optionIndex > row.options.length) {
    return { ok: false, message: `option index must be between 1 and ${row.options.length}` };
  }

  const choice = row.options[input.optionIndex - 1];
  const contextType = String(row.context.type ?? "");

  if (contextType === "person_disambiguation") {
    const blockId = String(row.context.blockId ?? "");
    if (blockId && choice.value.startsWith("entity:")) {
      const entityId = choice.value.slice("entity:".length);
      await supabase
        .from("links")
        .delete()
        .eq("from_type", "user_block")
        .eq("from_id", blockId)
        .eq("link_type", "candidate_match");

      await insertLink({
        fromType: "user_block",
        fromId: blockId,
        toType: "entity",
        toId: entityId,
        linkType: "about",
        confidence: 0.95,
        metadata: { resolved_by: "clarify" },
      });

      await supabase.from("entities").update({ verified: true, updated_at: new Date().toISOString() }).eq("id", entityId);
    } else if (blockId && choice.value.startsWith("new:")) {
      const mention = choice.value.slice("new:".length);
      const entityId = await createEntityCandidate(mention, 0.85);
      if (entityId) {
        await supabase.from("entities").update({ verified: true, updated_at: new Date().toISOString() }).eq("id", entityId);
        await insertLink({
          fromType: "user_block",
          fromId: blockId,
          toType: "entity",
          toId: entityId,
          linkType: "about",
          confidence: 0.9,
          metadata: { resolved_by: "clarify_new" },
        });
      }
    }
  }

  if (contextType === "person_new_confirm") {
    const blockId = String(row.context.blockId ?? "");
    if (choice.value.startsWith("confirm_new:")) {
      const entityId = choice.value.slice("confirm_new:".length);
      await supabase.from("entities").update({ verified: true, confidence: 0.9, updated_at: new Date().toISOString() }).eq("id", entityId);
      if (blockId) {
        await supabase
          .from("links")
          .delete()
          .eq("from_type", "user_block")
          .eq("from_id", blockId)
          .eq("link_type", "candidate_match")
          .eq("to_id", entityId);

        await insertLink({
          fromType: "user_block",
          fromId: blockId,
          toType: "entity",
          toId: entityId,
          linkType: "about",
          confidence: 0.9,
          metadata: { resolved_by: "clarify_confirm" },
        });
      }
    } else if (choice.value === "dismiss") {
      const candidateEntityId = String(row.context.candidateEntityId ?? "");
      if (candidateEntityId) {
        await supabase.from("entities").update({ confidence: 0.1, updated_at: new Date().toISOString() }).eq("id", candidateEntityId);
      }
    }
  }

  await supabase
    .from("clarification_queue")
    .update({
      status: "answered",
      answer: { optionIndex: input.optionIndex, value: choice.value, label: choice.label },
      answered_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.id);

  return { ok: true, message: `saved answer for ${input.id}: ${choice.label}` };
}

async function extractTextForFile(path: string, mimeType: string): Promise<string | null> {
  const ext = extname(path).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext)) {
    const text = await readFile(path, "utf-8").catch(() => "");
    return text.slice(0, MAX_EXTRACTED_TEXT);
  }

  if (mimeType === "application/pdf") {
    if (!(await commandExists("pdftotext"))) {
      throw new Error("pdftotext is required for PDF ingestion");
    }

    const proc = spawn(["pdftotext", path, "-"], { stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (stdout.trim()) return stdout.slice(0, MAX_EXTRACTED_TEXT);
  }

  if (AUDIO_EXTENSIONS.has(ext)) {
    return transcribeAudioWithOpenAI(path);
  }

  if (VIDEO_EXTENSIONS.has(ext)) {
    if (!(await commandExists("ffmpeg"))) {
      throw new Error("ffmpeg is required for video ingestion");
    }
    const tmpAudioPath = join(tmpdir(), `muavin-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
    const proc = spawn(
      ["ffmpeg", "-y", "-i", path, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", tmpAudioPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode !== 0) {
      throw new Error(`ffmpeg failed: ${stderr.trim() || `exit ${proc.exitCode}`}`);
    }
    try {
      return await transcribeAudioWithOpenAI(tmpAudioPath);
    } finally {
      await unlink(tmpAudioPath).catch(() => {});
    }
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return extractImageTextWithOpenAI(path, mimeType);
  }

  return null;
}

async function transcribeAudioWithOpenAI(path: string): Promise<string | null> {
  const file = Bun.file(path);
  const form = new FormData();
  form.set("model", OPENAI_TRANSCRIPTION_MODEL);
  form.set("file", file, basename(path));

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("OPENAI_API_KEY")}`,
    },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    throw new Error(`audio transcription failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { text?: string };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  return text ? text.slice(0, MAX_EXTRACTED_TEXT) : null;
}

async function extractImageTextWithOpenAI(path: string, mimeType: string): Promise<string | null> {
  const bytes = await Bun.file(path).bytes();
  const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "Extract readable text from the image. Return plain text only.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract any readable text from this image." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    throw new Error(`image extraction failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };

  const content = payload.choices?.[0]?.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((item) => (item && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }

  const normalized = text.trim();
  return normalized ? normalized.slice(0, MAX_EXTRACTED_TEXT) : null;
}

async function uploadToR2(path: string): Promise<string> {
  const r2 = getR2Config();
  if (!(await commandExists("aws"))) {
    throw new Error("aws CLI is required for R2 uploads");
  }

  const key = `${new Date().toISOString().slice(0, 10)}/${Date.now()}-${basename(path).replace(/\s+/g, "_")}`;

  const proc = spawn(
    ["aws", "s3", "cp", path, `s3://${r2.bucket}/${key}`, "--endpoint-url", r2.endpoint, "--only-show-errors"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: r2.accessKey,
        AWS_SECRET_ACCESS_KEY: r2.secretKey,
        AWS_DEFAULT_REGION: r2.region,
      },
    },
  );

  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`R2 upload failed: ${stderr.trim() || `aws exit ${proc.exitCode}`}`);
  }
  return key;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkFiles(path);
      out.push(...nested);
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

export async function ingestFileArtifactFromPath(input: {
  filePath: string;
  title?: string;
  metadata?: Record<string, unknown>;
  sourceType?: "file";
}): Promise<{ artifactId: string; created: boolean; checksum: string; objectKey: string | null; textContent: string | null }> {
  const filePath = input.filePath;
  const st = await stat(filePath);
  if (st.size === 0) {
    throw new Error("cannot ingest empty file");
  }

  getR2Config();
  if (!(await commandExists("aws"))) {
    throw new Error("aws CLI is required for R2 uploads");
  }

  const checksum = await computeSha256(filePath);
  const { data: existing } = await supabase
    .from("artifacts")
    .select("id, text_content, object_key")
    .eq("source_type", input.sourceType ?? "file")
    .eq("checksum", checksum)
    .limit(1);

  if (existing && existing.length > 0) {
    const row = existing[0] as { id: string; text_content: string | null; object_key: string | null };
    const inputHash = await hashText(`${checksum}:${row.text_content ?? ""}`);
    await queueProcessingState("artifact", row.id, inputHash).catch(() => {});
    return {
      artifactId: row.id,
      created: false,
      checksum,
      objectKey: row.object_key ?? null,
      textContent: row.text_content ?? null,
    };
  }

  const mimeType = fileMimeType(filePath);
  const objectKey = await uploadToR2(filePath);
  const textContent = await extractTextForFile(filePath, mimeType);
  const artifactMetadata = {
    ...(input.metadata ?? {}),
    local_path: filePath,
    size_bytes: st.size,
    extension: extname(filePath).toLowerCase(),
    uploaded_to_r2: true,
  };

  const { data: artifact, error: artifactError } = await supabase
    .from("artifacts")
    .insert({
      source_type: input.sourceType ?? "file",
      title: input.title ?? basename(filePath),
      mime_type: mimeType,
      text_content: textContent,
      object_key: objectKey,
      checksum,
      metadata: artifactMetadata,
      ingest_status: "parsed",
    })
    .select("id")
    .single();

  if (artifactError || !artifact) {
    throw new Error(`artifact insert failed: ${artifactError?.message ?? "unknown error"}`);
  }

  const artifactId = (artifact as { id: string }).id;
  const inputHash = await hashText(`${checksum}:${textContent ?? ""}`);
  await queueProcessingState("artifact", artifactId, inputHash).catch(() => {});
  return { artifactId, created: true, checksum, objectKey, textContent };
}

export async function ingestFilesInbox(): Promise<{ scanned: number; ingested: number; skipped: number; errored: number }> {
  const config = await loadConfig();
  const inboxDir = (typeof config.filesInboxDir === "string" && config.filesInboxDir.length > 0)
    ? config.filesInboxDir
    : join(homedir(), ".muavin", "inbox", "files");

  await mkdir(inboxDir, { recursive: true });

  const files = await walkFiles(inboxDir);
  getR2Config();
  if (!(await commandExists("aws"))) {
    throw new Error("aws CLI is required for R2 uploads");
  }

  let ingested = 0;
  let skipped = 0;
  let errored = 0;

  for (const filePath of files) {
    try {
      const result = await ingestFileArtifactFromPath({ filePath, sourceType: "file" });
      if (result.created) ingested++;
      else skipped++;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      try {
        await supabase.from("artifacts").insert({
          source_type: "file",
          title: basename(filePath),
          mime_type: fileMimeType(filePath),
          metadata: { local_path: filePath },
          ingest_status: "error",
          error: errMsg.slice(0, 1000),
        });
      } catch {
        // best-effort error record
      }
      errored++;
    }
  }

  return { scanned: files.length, ingested, skipped, errored };
}

interface PendingUserBlockRow {
  id: string;
  content: string;
  source: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  input_hash: string;
}

interface PendingArtifactRow {
  id: string;
  source_type: string;
  title: string | null;
  mime_type: string | null;
  text_content: string | null;
  object_key: string | null;
  metadata: Record<string, unknown>;
  ingest_status: string;
  input_hash: string;
}

function parseStructuredOutput<T>(raw: unknown): T | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as T;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return null;
}

function clampConfidence(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, Number(value)));
}

function sanitizeProcessorBlocks(input: ProcessorMuaBlockDraft[]): ProcessorMuaBlockDraft[] {
  const out: ProcessorMuaBlockDraft[] = [];
  for (const row of input) {
    const content = normalizeWhitespace(String(row.content ?? ""));
    if (!content) continue;
    out.push({
      content: content.slice(0, 3000),
      block_kind: row.block_kind ?? "note",
      confidence: clampConfidence(row.confidence, 0.65),
    });
    if (out.length >= 6) break;
  }
  return out;
}

async function getPendingUserBlocks(limit: number): Promise<PendingUserBlockRow[]> {
  const { data: queueRows } = await supabase
    .from("processing_state")
    .select("subject_id, input_hash")
    .eq("subject_type", "user_block")
    .in("state", ["pending", "error"])
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (!queueRows || queueRows.length === 0) return [];

  const ids = queueRows.map((q) => String((q as { subject_id: string }).subject_id));
  const hashById = new Map<string, string>(
    queueRows.map((q) => [String((q as { subject_id: string }).subject_id), String((q as { input_hash: string }).input_hash)]),
  );

  const { data, error } = await supabase
    .from("user_blocks")
    .select("id, content, source, created_at, updated_at, metadata")
    .in("id", ids);
  if (error || !data) return [];

  return (data as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    content: String(row.content ?? ""),
    source: String(row.source ?? ""),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    metadata: metadataRecord(row.metadata),
    input_hash: hashById.get(String(row.id)) ?? "",
  }));
}

async function getPendingArtifacts(limit: number): Promise<PendingArtifactRow[]> {
  const { data: queueRows } = await supabase
    .from("processing_state")
    .select("subject_id, input_hash")
    .eq("subject_type", "artifact")
    .in("state", ["pending", "error"])
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (!queueRows || queueRows.length === 0) return [];

  const ids = queueRows.map((q) => String((q as { subject_id: string }).subject_id));
  const hashById = new Map<string, string>(
    queueRows.map((q) => [String((q as { subject_id: string }).subject_id), String((q as { input_hash: string }).input_hash)]),
  );

  const { data, error } = await supabase
    .from("artifacts")
    .select("id, source_type, title, mime_type, text_content, object_key, metadata, ingest_status")
    .in("id", ids);
  if (error || !data) return [];

  return (data as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    source_type: String(row.source_type ?? ""),
    title: row.title ? String(row.title) : null,
    mime_type: row.mime_type ? String(row.mime_type) : null,
    text_content: row.text_content ? String(row.text_content) : null,
    object_key: row.object_key ? String(row.object_key) : null,
    metadata: metadataRecord(row.metadata),
    ingest_status: String(row.ingest_status ?? "parsed"),
    input_hash: hashById.get(String(row.id)) ?? "",
  }));
}

function blockCandidateRows(rows: RelatedBlock[], selfId: string): Array<Record<string, unknown>> {
  return rows
    .filter((r) => r.authorType === "user" && r.id !== selfId)
    .slice(0, 10)
    .map((r) => ({
      id: r.id,
      author_type: r.authorType,
      score: Number(r.score.toFixed(3)),
      content_preview: truncateForPrompt(r.content, 420),
      block_kind: r.blockKind,
    }));
}

function truncateForPrompt(text: string, max = 1200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated]`;
}

async function runBlockProcessor(block: PendingUserBlockRow): Promise<BlockProcessResult> {
  const related = await searchRelatedBlocks({
    query: block.content,
    scope: "all",
    limit: 12,
  }).catch(() => []);

  const candidates = blockCandidateRows(related, block.id);
  const prompt = [
    "You are Muavin's block processor.",
    "Analyze one user block and produce structured outputs for CRM/knowledge updates.",
    "",
    "Rules:",
    "- Keep analysis factual and concise.",
    "- `mua_blocks` should be atomic and useful (0-5 items).",
    "- Use `block_kind`=`action_open` for unresolved next steps/questions, `action_closed` for explicitly completed outcomes, otherwise `note`.",
    "- `related_block_ids` must only use ids from candidate_related_blocks.",
    "- `entity_names` should only include likely people (proper names), not generic nouns.",
    "- Do not repeat the user block verbatim.",
    "",
    "user_block:",
    JSON.stringify({
      id: block.id,
      source: block.source,
      created_at: block.created_at,
      updated_at: block.updated_at,
      content: block.content,
    }, null, 2),
    "",
    "candidate_related_blocks:",
    JSON.stringify(candidates, null, 2),
  ].join("\n");

  const result = await callClaude(prompt, {
    cwd: SYSTEM_CWD,
    noSessionPersistence: true,
    maxTurns: 4,
    timeoutMs: 120_000,
    jsonSchema: BLOCK_PROCESS_SCHEMA,
  });
  const parsed = parseStructuredOutput<BlockProcessResult>(result.structuredOutput ?? result.text);
  if (!parsed) throw new Error("block processor returned invalid structured output");
  return {
    analysis: normalizeWhitespace(String(parsed.analysis ?? "")),
    mua_blocks: sanitizeProcessorBlocks(Array.isArray(parsed.mua_blocks) ? parsed.mua_blocks : []),
    related_block_ids: Array.isArray(parsed.related_block_ids) ? parsed.related_block_ids.map((id) => String(id)) : [],
    entity_names: Array.isArray(parsed.entity_names) ? parsed.entity_names.map((name) => String(name)) : [],
  };
}

async function runArtifactProcessor(artifact: PendingArtifactRow): Promise<ArtifactProcessResult> {
  const text = normalizeWhitespace(artifact.text_content ?? "");
  const textSnippet = text ? truncateForPrompt(text, 18_000) : "";
  const prompt = [
    "You are Muavin's artifact processor.",
    "Analyze one ingested artifact and produce structured outputs.",
    "",
    "Rules:",
    "- `description` should summarize what the file is (1-2 sentences).",
    "- `mua_blocks` should be atomic notes/actions extracted from the artifact (0-6 items).",
    "- Use `block_kind`=`action_open` for unresolved next steps/questions, `action_closed` for explicitly completed outcomes, otherwise `note`.",
    "- `entity_names` should only include likely people (proper names).",
    "",
    "artifact:",
    JSON.stringify({
      id: artifact.id,
      source_type: artifact.source_type,
      title: artifact.title,
      mime_type: artifact.mime_type,
      object_key: artifact.object_key,
      metadata: artifact.metadata,
      extracted_text_available: text.length > 0,
    }, null, 2),
    "",
    "extracted_text:",
    textSnippet || "(none)",
  ].join("\n");

  const result = await callClaude(prompt, {
    cwd: SYSTEM_CWD,
    noSessionPersistence: true,
    maxTurns: 4,
    timeoutMs: 180_000,
    jsonSchema: ARTIFACT_PROCESS_SCHEMA,
  });
  const parsed = parseStructuredOutput<ArtifactProcessResult>(result.structuredOutput ?? result.text);
  if (!parsed) throw new Error("artifact processor returned invalid structured output");
  return {
    description: normalizeWhitespace(String(parsed.description ?? "")),
    mua_blocks: sanitizeProcessorBlocks(Array.isArray(parsed.mua_blocks) ? parsed.mua_blocks : []),
    entity_names: Array.isArray(parsed.entity_names) ? parsed.entity_names.map((name) => String(name)) : [],
  };
}

async function createProcessorMuaBlocks(input: {
  drafts: ProcessorMuaBlockDraft[];
  metadata: Record<string, unknown>;
  derivedFrom: { type: "user_block" | "artifact"; id: string };
  relatedBlockIds?: string[];
  entityIds?: string[];
}): Promise<number> {
  let created = 0;
  for (const draft of input.drafts) {
    const dedupeKey = await hashText(
      `${input.derivedFrom.type}:${input.derivedFrom.id}:${PROCESSOR_VERSION}:${draft.block_kind ?? "note"}:${normalizeWhitespace(draft.content)}`,
    );
    const block = await createMuaBlock({
      content: draft.content,
      blockKind: draft.block_kind ?? "note",
      confidence: clampConfidence(draft.confidence, 0.65),
      source: "system",
      sourceRef: normalizeSourceRef("system", {
        type: input.derivedFrom.type === "user_block" ? "processor_user_block" : "processor_artifact",
        id: { subject_id: input.derivedFrom.id, processor_version: PROCESSOR_VERSION },
      }),
      metadata: input.metadata,
      dedupeKey,
    });
    created++;

    await insertLink({
      fromType: "mua_block",
      fromId: block.id,
      toType: input.derivedFrom.type,
      toId: input.derivedFrom.id,
      linkType: "derived_from",
      confidence: 1,
      metadata: { processor_version: PROCESSOR_VERSION },
    });

    for (const relatedId of input.relatedBlockIds ?? []) {
      await insertLink({
        fromType: "mua_block",
        fromId: block.id,
        toType: "user_block",
        toId: relatedId,
        linkType: "related",
        confidence: 0.7,
        metadata: { processor_version: PROCESSOR_VERSION },
      });
    }

    for (const entityId of input.entityIds ?? []) {
      await insertLink({
        fromType: "mua_block",
        fromId: block.id,
        toType: "entity",
        toId: entityId,
        linkType: "about",
        confidence: 0.75,
        metadata: { processor_version: PROCESSOR_VERSION },
      });
    }
  }
  return created;
}

async function markProcessingStarted(subjectType: "user_block" | "artifact", subjectId: string): Promise<void> {
  const { data: existing } = await supabase
    .from("processing_state")
    .select("attempts")
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .maybeSingle();
  const attempts = Number((existing as { attempts?: number } | null)?.attempts ?? 0) + 1;

  await supabase
    .from("processing_state")
    .update({
      state: "processing",
      attempts,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId);
}

async function markProcessingDone(subjectType: "user_block" | "artifact", subjectId: string, inputHash: string): Promise<void> {
  await supabase
    .from("processing_state")
    .update({
      state: "processed",
      last_processed_hash: inputHash,
      last_error: null,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId);
}

async function markProcessingError(subjectType: "user_block" | "artifact", subjectId: string, error: string): Promise<void> {
  await supabase
    .from("processing_state")
    .update({
      state: "error",
      last_error: error.slice(0, 1000),
      updated_at: new Date().toISOString(),
    })
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId);
}

async function processUserBlock(row: PendingUserBlockRow): Promise<{ ok: boolean; createdMuaBlocks: number }> {
  await markProcessingStarted("user_block", row.id);

  try {
    const output = await runBlockProcessor(row);
    const entityIds: string[] = [];
    for (const entityName of output.entity_names.slice(0, 10)) {
      const entity = await ensurePersonEntity(entityName, 0.65);
      if (!entity) continue;
      entityIds.push(entity.id);
      await insertLink({
        fromType: "user_block",
        fromId: row.id,
        toType: "entity",
        toId: entity.id,
        linkType: "mentions",
        confidence: 0.72,
        metadata: { processor_version: PROCESSOR_VERSION, entity_name: entityName },
      });
    }

    const relatedBlockIds = output.related_block_ids
      .filter((id) => id && id !== row.id)
      .slice(0, 8);
    for (const relatedId of relatedBlockIds) {
      await insertLink({
        fromType: "user_block",
        fromId: row.id,
        toType: "user_block",
        toId: relatedId,
        linkType: "references",
        confidence: 0.58,
        metadata: { processor_version: PROCESSOR_VERSION },
      });
    }

    const createdMuaBlocks = await createProcessorMuaBlocks({
      drafts: output.mua_blocks,
      metadata: {
        processor_version: PROCESSOR_VERSION,
        source_user_block_id: row.id,
        analysis: output.analysis,
        type: "block_processor",
      },
      derivedFrom: { type: "user_block", id: row.id },
      relatedBlockIds,
      entityIds,
    });

    await markProcessingDone("user_block", row.id, row.input_hash);

    return { ok: true, createdMuaBlocks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markProcessingError("user_block", row.id, message);
    return { ok: false, createdMuaBlocks: 0 };
  }
}

async function processArtifact(row: PendingArtifactRow): Promise<{ ok: boolean; createdMuaBlocks: number }> {
  await markProcessingStarted("artifact", row.id);

  try {
    const output = await runArtifactProcessor(row);
    const entityIds: string[] = [];
    for (const entityName of output.entity_names.slice(0, 10)) {
      const entity = await ensurePersonEntity(entityName, 0.65);
      if (!entity) continue;
      entityIds.push(entity.id);
      await insertLink({
        fromType: "artifact",
        fromId: row.id,
        toType: "entity",
        toId: entity.id,
        linkType: "mentions",
        confidence: 0.7,
        metadata: { processor_version: PROCESSOR_VERSION, entity_name: entityName },
      });
    }

    const createdDescription = output.description
      ? await createProcessorMuaBlocks({
          drafts: [
            {
              content: output.description,
              block_kind: "note",
              confidence: 0.8,
            },
          ],
          metadata: {
            processor_version: PROCESSOR_VERSION,
            source_artifact_id: row.id,
            type: "artifact_description",
          },
          derivedFrom: { type: "artifact", id: row.id },
          entityIds,
        })
      : 0;

    const createdInsights = await createProcessorMuaBlocks({
      drafts: output.mua_blocks,
      metadata: {
        processor_version: PROCESSOR_VERSION,
        source_artifact_id: row.id,
        description: output.description,
        type: "artifact_processor",
      },
      derivedFrom: { type: "artifact", id: row.id },
      entityIds,
    });

    const updatedMetadata = {
      ...row.metadata,
      file_description: output.description || null,
      topics: output.description ? toTopicTokens(output.description) : [],
    };

    await supabase
      .from("artifacts")
      .update({
        metadata: updatedMetadata,
        ingest_status: "linked",
        updated_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", row.id);
    await markProcessingDone("artifact", row.id, row.input_hash);

    return { ok: true, createdMuaBlocks: createdDescription + createdInsights };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from("artifacts")
      .update({
        ingest_status: "error",
        error: message.slice(0, 1000),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    await markProcessingError("artifact", row.id, message);
    return { ok: false, createdMuaBlocks: 0 };
  }
}

export async function processPendingState(opts?: {
  userLimit?: number;
  artifactLimit?: number;
}): Promise<ProcessPendingStateResult> {
  const userLimit = Math.max(1, Math.min(opts?.userLimit ?? 20, 100));
  const artifactLimit = Math.max(1, Math.min(opts?.artifactLimit ?? 10, 50));

  const pendingUsers = await getPendingUserBlocks(userLimit);
  const pendingArtifacts = await getPendingArtifacts(artifactLimit);

  let userProcessed = 0;
  let userErrored = 0;
  for (const row of pendingUsers) {
    const result = await processUserBlock(row);
    if (result.ok) userProcessed++;
    else userErrored++;
  }

  let artifactsProcessed = 0;
  let artifactsErrored = 0;
  for (const row of pendingArtifacts) {
    const result = await processArtifact(row);
    if (result.ok) artifactsProcessed++;
    else artifactsErrored++;
  }

  return {
    userScanned: pendingUsers.length,
    userProcessed,
    userErrored,
    artifactsScanned: pendingArtifacts.length,
    artifactsProcessed,
    artifactsErrored,
  };
}

export async function listArtifacts(limit = 50): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await supabase
    .from("artifacts")
    .select("id, created_at, source_type, title, mime_type, ingest_status, error, metadata")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data as Array<Record<string, unknown>>;
}

async function fetchBlocksByIds(authorType: "user" | "mua", ids: string[]): Promise<Map<string, { created_at: string; content: string; source: string }>> {
  if (ids.length === 0) return new Map();
  const table = authorType === "user" ? "user_blocks" : "mua_blocks";
  const out = new Map<string, { created_at: string; content: string; source: string }>();

  for (const part of chunk(ids, 100)) {
    const { data } = await supabase
      .from(table)
      .select("id, created_at, content, source")
      .in("id", part);

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      out.set(String(row.id), {
        created_at: String(row.created_at),
        content: String(row.content),
        source: String(row.source ?? ""),
      });
    }
  }

  return out;
}

export async function getCrmSummary(input?: {
  topicFilter?: string;
  peopleFilter?: string;
  limit?: number;
}): Promise<CrmPersonSummary[]> {
  const limit = input?.limit ?? 25;
  let entityQuery = supabase
    .from("entities")
    .select("id, canonical_name, aliases, verified")
    .eq("entity_type", "person")
    .order("updated_at", { ascending: false })
    .limit(200);
  const { data: entitiesData } = await entityQuery;
  let entities = (entitiesData ?? []) as Array<Record<string, unknown>>;
  if (input?.peopleFilter && input.peopleFilter.trim()) {
    const token = input.peopleFilter.trim().toLowerCase();
    entities = entities.filter((e) => {
      const canonical = String(e.canonical_name ?? "").toLowerCase();
      if (canonical.includes(token)) return true;
      const aliases = (e.aliases as string[] | undefined) ?? [];
      return aliases.some((a) => a.toLowerCase().includes(token));
    });
  }
  const summaries: CrmPersonSummary[] = [];

  for (const entity of entities) {
    const entityId = String(entity.id);
    const name = String(entity.canonical_name);

    const { data: linksData } = await supabase
      .from("links")
      .select("from_type, from_id, link_type, confidence")
      .eq("to_type", "entity")
      .eq("to_id", entityId)
      .in("link_type", ["about", "mentions", "candidate_match"])
      .limit(300);

    const links = (linksData ?? []) as Array<Record<string, unknown>>;
    const userIds = links.filter((l) => l.from_type === "user_block").map((l) => String(l.from_id));
    const muaIds = links.filter((l) => l.from_type === "mua_block").map((l) => String(l.from_id));

    const [userBlocks, muaBlocks, openLoopsData] = await Promise.all([
      fetchBlocksByIds("user", userIds),
      fetchBlocksByIds("mua", muaIds),
      supabase
        .from("links")
        .select("from_id")
        .eq("to_type", "entity")
        .eq("to_id", entityId)
        .eq("from_type", "mua_block")
        .eq("link_type", "about")
        .limit(300),
    ]);

    const timeline: CrmTimelineItem[] = [];

    for (const id of userIds) {
      const block = userBlocks.get(id);
      if (!block) continue;
      timeline.push({
        at: block.created_at,
        content: block.content,
        authorType: "user",
        source: block.source,
      });
    }

    for (const id of muaIds) {
      const block = muaBlocks.get(id);
      if (!block) continue;
      timeline.push({
        at: block.created_at,
        content: block.content,
        authorType: "mua",
        source: block.source,
      });
    }

    timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    let openLoops = 0;
    const openLoopIds = ((openLoopsData.data ?? []) as Array<Record<string, unknown>>).map((r) => String(r.from_id));
    if (openLoopIds.length > 0) {
      const { data: loops } = await supabase
        .from("mua_blocks")
        .select("id")
        .in("id", openLoopIds)
        .eq("block_kind", "action_open");
      openLoops = loops?.length ?? 0;
    }

    const lastContactAt = timeline.length > 0 ? timeline[0].at : null;
    const daysSince = lastContactAt
      ? Math.max(0, Math.floor((Date.now() - new Date(lastContactAt).getTime()) / (1000 * 60 * 60 * 24)))
      : null;

    const recentTopics = toTopicTokens(timeline.slice(0, 15).map((t) => t.content).join(" "));

    if (input?.topicFilter && input.topicFilter.trim()) {
      const token = input.topicFilter.trim().toLowerCase();
      const hasTopic = timeline.some((t) => t.content.toLowerCase().includes(token)) || recentTopics.includes(token);
      if (!hasTopic) continue;
    }

    const roiScore =
      (openLoops * 2)
      + (daysSince === null ? 1.5 : Math.min(daysSince / 7, 5))
      + (timeline.length > 0 ? 0.6 : 0);

    summaries.push({
      entityId,
      name,
      verified: Boolean(entity.verified),
      lastContactAt,
      daysSinceContact: daysSince,
      openLoops,
      roiScore: Number(roiScore.toFixed(2)),
      recentTopics,
      timeline: timeline.slice(0, 12),
    });
  }

  return summaries
    .sort((a, b) => b.roiScore - a.roiScore)
    .slice(0, limit);
}
