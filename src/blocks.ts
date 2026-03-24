import { readdir, readFile, stat, mkdir, unlink } from "fs/promises";
import { join, extname, basename } from "path";
import { homedir, tmpdir } from "os";
import { spawn } from "bun";
import { embed, getActiveEmbeddingProfileId, supabase, upsertBlockEmbedding } from "./db";
import { loadConfig } from "./utils";
import { runLLM } from "./llm";
import { logSystemEvent } from "./events";
import {
  ActionClosedMeta,
  ActionOpenMeta,
  type ActionClosedReason,
  MergeCandidateMeta,
  ReviewSourceMeta,
} from "./metadata-schemas";

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
  | "agent"
  | "live";
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
  name: string;
  aliases: string[];
  created_at?: string;
}

interface ProcessorMuaBlockDraft {
  content: string;
  block_kind?: "note" | "action_open" | "action_closed";
}

interface RelatedBlockDraft {
  id: string;
  label?: string;
}

interface BlockProcessResult {
  analysis: string;
  mua_blocks: ProcessorMuaBlockDraft[];
  related_blocks: RelatedBlockDraft[];
  entity_names: string[];
}

interface ArtifactProcessResult {
  description: string;
  mua_blocks: ProcessorMuaBlockDraft[];
  entity_names: string[];
}

interface ReviewTagDraft {
  name: string;
}

interface ReviewMissedLinkDraft {
  block_id: string;
  block_type: "user_block" | "mua_block";
  entity_name: string;
  label?: string;
}

interface ReviewAliasUpdateDraft {
  entity_id: string;
  new_alias: string;
}

interface ReviewMergeCandidateDraft {
  entity_id_keep: string;
  entity_id_merge: string;
  reason: string;
}

interface DailyMergeDraft {
  keep_id: string;
  merge_id: string;
}

interface DailyTagOpDraft {
  op: "rename" | "merge";
  entity_id: string;
  new_name?: string;
  merge_into_id?: string;
}

interface ReviewConnectionDraft {
  from_type: "user_block" | "mua_block" | "artifact" | "entity";
  from_id: string;
  to_type: "user_block" | "mua_block" | "artifact" | "entity";
  to_id: string;
  label: string;
}

interface ReviewLabelUpdateDraft {
  link_id: string;
  label: string;
}

interface HourlyReviewOutput {
  summary: string;
  new_tags: ReviewTagDraft[];
  missed_links: ReviewMissedLinkDraft[];
  alias_updates: ReviewAliasUpdateDraft[];
  merge_candidates: ReviewMergeCandidateDraft[];
}

interface DailyReviewOutput {
  summary: string;
  merges: DailyMergeDraft[];
  tag_ops: DailyTagOpDraft[];
  new_connections: ReviewConnectionDraft[];
  label_updates: ReviewLabelUpdateDraft[];
}

interface WeeklyPruneDraft {
  entity_id: string;
  reason: string;
}

interface WeeklyStaleActionDraft {
  block_id: string;
  age_days: number;
  suggestion: "close" | "keep" | "nudge";
}

interface WeeklyCleanupDraft {
  type: string;
  id: string;
  action: string;
  reason: string;
}

interface WeeklyReviewOutput {
  summary: string;
  prune: WeeklyPruneDraft[];
  stale_actions: WeeklyStaleActionDraft[];
  cleanup: WeeklyCleanupDraft[];
  observations: string;
  missed_links: ReviewMissedLinkDraft[];
  merge_candidates: ReviewMergeCandidateDraft[];
  new_connections: ReviewConnectionDraft[];
  alias_updates: ReviewAliasUpdateDraft[];
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
  lastContactAt: string | null;
  daysSinceContact: number | null;
  openLoops: number;
  roiScore: number;
  recentTopics: string[];
  timeline: CrmTimelineItem[];
}

type ReviewSource = "state_processor" | "hourly_review" | "daily_review" | "weekly_review";

interface ReviewJobResult {
  summary: string;
}

interface HourlyReviewResult extends ReviewJobResult {
  createdTags: number;
  missedLinks: number;
  aliasUpdates: number;
  mergeCandidates: number;
}

interface DailyReviewResult extends ReviewJobResult {
  merges: number;
  rejectedMergeCandidates: number;
  tagOps: number;
  newConnections: number;
  labelUpdates: number;
}

interface WeeklyReviewResult extends ReviewJobResult {
  pruned: number;
  closedActions: number;
  nudges: number;
  cleanupFixes: number;
  observations: number;
  aliasUpdates: number;
  missedLinks: number;
  mergeCandidates: number;
  merges: number;
  tagOps: number;
  newConnections: number;
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
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
    related_blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    entity_names: { type: "array", items: { type: "string" } },
  },
  required: ["analysis", "mua_blocks", "related_blocks", "entity_names"],
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

const HOURLY_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    new_tags: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
    missed_links: {
      type: "array",
      items: {
        type: "object",
        properties: {
          block_id: { type: "string" },
          block_type: { type: "string", enum: ["user_block", "mua_block"] },
          entity_name: { type: "string" },
          label: { type: "string" },
        },
        required: ["block_id", "block_type", "entity_name"],
        additionalProperties: false,
      },
    },
    alias_updates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entity_id: { type: "string" },
          new_alias: { type: "string" },
        },
        required: ["entity_id", "new_alias"],
        additionalProperties: false,
      },
    },
    merge_candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entity_id_keep: { type: "string" },
          entity_id_merge: { type: "string" },
          reason: { type: "string" },
        },
        required: ["entity_id_keep", "entity_id_merge", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "new_tags", "missed_links", "alias_updates", "merge_candidates"],
  additionalProperties: false,
} as const;

const DAILY_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    merges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          keep_id: { type: "string" },
          merge_id: { type: "string" },
        },
        required: ["keep_id", "merge_id"],
        additionalProperties: false,
      },
    },
    tag_ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["rename", "merge"] },
          entity_id: { type: "string" },
          new_name: { type: "string" },
          merge_into_id: { type: "string" },
        },
        required: ["op", "entity_id"],
        additionalProperties: false,
      },
    },
    new_connections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from_type: { type: "string", enum: ["user_block", "mua_block", "artifact", "entity"] },
          from_id: { type: "string" },
          to_type: { type: "string", enum: ["user_block", "mua_block", "artifact", "entity"] },
          to_id: { type: "string" },
          label: { type: "string" },
        },
        required: ["from_type", "from_id", "to_type", "to_id", "label"],
        additionalProperties: false,
      },
    },
    label_updates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          link_id: { type: "string" },
          label: { type: "string" },
        },
        required: ["link_id", "label"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "merges", "tag_ops", "new_connections", "label_updates"],
  additionalProperties: false,
} as const;

const WEEKLY_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    prune: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entity_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["entity_id", "reason"],
        additionalProperties: false,
      },
    },
    stale_actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          block_id: { type: "string" },
          age_days: { type: "number" },
          suggestion: { type: "string", enum: ["close", "keep", "nudge"] },
        },
        required: ["block_id", "age_days", "suggestion"],
        additionalProperties: false,
      },
    },
    cleanup: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          id: { type: "string" },
          action: { type: "string" },
          reason: { type: "string" },
        },
        required: ["type", "id", "action", "reason"],
        additionalProperties: false,
      },
    },
    observations: { type: "string" },
    missed_links: HOURLY_REVIEW_SCHEMA.properties.missed_links,
    merge_candidates: HOURLY_REVIEW_SCHEMA.properties.merge_candidates,
    new_connections: DAILY_REVIEW_SCHEMA.properties.new_connections,
    alias_updates: HOURLY_REVIEW_SCHEMA.properties.alias_updates,
  },
  required: ["summary", "prune", "stale_actions", "cleanup", "observations", "missed_links", "merge_candidates", "new_connections", "alias_updates"],
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

function warnMetadataValidation(context: string, issues: string): void {
  console.warn(`[metadata] ${context}: ${issues}`);
}

function validateMuaMetadata(
  blockKind: "note" | "action_open" | "action_closed",
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const baseParsed = ReviewSourceMeta.safeParse(metadata);
  if (!baseParsed.success) {
    warnMetadataValidation(`review-source ${blockKind}`, baseParsed.error.issues.map((issue) => issue.message).join("; "));
  }

  if (blockKind === "action_open") {
    const parsed = ActionOpenMeta.safeParse(metadata);
    if (!parsed.success) {
      warnMetadataValidation("action_open", parsed.error.issues.map((issue) => issue.message).join("; "));
      return metadata;
    }
    return parsed.data;
  }

  if (blockKind === "action_closed") {
    const parsed = ActionClosedMeta.safeParse(metadata);
    if (!parsed.success) {
      warnMetadataValidation("action_closed", parsed.error.issues.map((issue) => issue.message).join("; "));
      return metadata;
    }
    return parsed.data;
  }

  return metadata;
}

function extractLastAcknowledgedAt(metadata: Record<string, unknown>): string | null {
  const parsed = ActionOpenMeta.safeParse(metadata);
  if (!parsed.success) {
    warnMetadataValidation("read action_open", parsed.error.issues.map((issue) => issue.message).join("; "));
    return null;
  }
  return parsed.data.last_acknowledged_at ?? null;
}

interface SourceRefBase {
  v: 1;
  extras: Record<string, unknown>;
}

interface TelegramMessageRef extends SourceRefBase {
  type: "telegram_message";
  id: { chat_id: string; message_id: number | null; artifact_id?: string };
}

interface LiveSessionRef extends SourceRefBase {
  type: "live_session";
  id: { session_id: string; turn: number };
}

interface ImportBatchRef extends SourceRefBase {
  type: "import_batch";
  id: { batch_id: string; origin: string };
}

interface CliInputRef extends SourceRefBase {
  type: "cli_input";
  id: Record<string, unknown>;
}

interface JobRunRef extends SourceRefBase {
  type: "job_run";
  id: { job_name: string; run_id?: string };
}

interface AgentRunRef extends SourceRefBase {
  type: "agent_run";
  id: { agent_id: string };
}

interface ProcessorRef extends SourceRefBase {
  type: "processor_user_block" | "processor_artifact";
  id: { subject_id: string; processor_version: number };
}

interface ArtifactRef extends SourceRefBase {
  type: "artifact";
  id: Record<string, unknown>;
}

interface ExternalObjectRef extends SourceRefBase {
  type: "external_object";
  id: Record<string, unknown>;
}

export type SourceRef =
  | TelegramMessageRef
  | LiveSessionRef
  | ImportBatchRef
  | CliInputRef
  | JobRunRef
  | AgentRunRef
  | ProcessorRef
  | ArtifactRef
  | ExternalObjectRef;

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

function normalizeSourceRef(channel: BlockSource, sourceRef?: SourceRef | Record<string, unknown>): SourceRef {
  const input = metadataRecord(sourceRef);
  const id = metadataRecord(input.id);
  const extras = metadataRecord(input.extras);
  const type = typeof input.type === "string" ? input.type : sourceRefTypeFor(channel);
  return {
    v: 1,
    type,
    id: Object.keys(id).length > 0 ? id : input,
    extras,
  } as SourceRef;
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
  sourceRef: SourceRef;
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
  sourceRef: SourceRef;
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

async function findEntities(name: string): Promise<EntityRow[]> {
  const { data, error } = await supabase
    .from("entities")
    .select("id, name, aliases, created_at")
    .limit(200);

  if (error || !data) return [];
  const lowered = name.toLowerCase();
  return (data as EntityRow[])
    .filter((r) => {
      if (r.name.toLowerCase().includes(lowered)) return true;
      return (r.aliases ?? []).some((a) => a.toLowerCase().includes(lowered));
    })
    .slice(0, 10);
}

async function findEntitiesLoose(name: string): Promise<EntityRow[]> {
  const lowered = name.toLowerCase();
  const { data, error } = await supabase
    .from("entities")
    .select("id, name, aliases, created_at")
    .limit(200);

  if (error || !data) return [];
  const rows = data as EntityRow[];
  return rows.filter((r) => {
    if (r.name.toLowerCase().includes(lowered)) return true;
    return (r.aliases ?? []).some((a) => a.toLowerCase().includes(lowered));
  });
}

async function createEntityCandidate(name: string): Promise<string | null> {
  const displayName = name
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  const { data, error } = await supabase
    .from("entities")
    .insert({
      name: displayName,
      aliases: [name],
    })
    .select("id")
    .single();

  if (error || !data) return null;
  return (data as { id: string }).id;
}

export async function ensureEntity(name: string): Promise<EntityRow | null> {
  const cleaned = normalizeWhitespace(name);
  if (!cleaned) return null;

  const normalized = normalizeEntityName(cleaned);
  const lowered = normalized.toLowerCase();
  const matches = await findEntitiesLoose(normalized);
  if (matches.length > 0) {
    const exact = matches.find((m) => {
      if (m.name.toLowerCase() === lowered) return true;
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

  const id = await createEntityCandidate(normalized);
  if (!id) return null;
  return {
    id,
    name: normalized,
    aliases: [normalized],
  };
}

export async function insertLink(input: {
  fromType: "user_block" | "mua_block" | "entity" | "artifact";
  fromId: string;
  toType: "user_block" | "mua_block" | "entity" | "artifact";
  toId: string;
  linkType: "about" | "derived_from" | "related";
  label?: string;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  const { data: existing } = await supabase
    .from("links")
    .select("id, label")
    .eq("from_type", input.fromType)
    .eq("from_id", input.fromId)
    .eq("to_type", input.toType)
    .eq("to_id", input.toId)
    .eq("link_type", input.linkType)
    .limit(1);
  if ((existing?.length ?? 0) > 0) {
    const existingRow = (existing ?? [])[0] as { id: string; label?: string | null } | undefined;
    if (existingRow?.id && input.linkType === "related" && input.label && !existingRow.label) {
      await setLinkLabel(existingRow.id, input.label);
    }
    return existingRow?.id ?? null;
  }

  const { data, error } = await supabase.from("links").insert({
    from_type: input.fromType,
    from_id: input.fromId,
    to_type: input.toType,
    to_id: input.toId,
    link_type: input.linkType,
    metadata: input.metadata ?? {},
  }).select("id").single();

  if (error || !data) return null;

  const linkId = String((data as { id: string }).id);
  if (input.linkType === "related" && input.label) {
    await setLinkLabel(linkId, input.label);
  }
  return linkId;
}

async function setLinkLabel(linkId: string, label: string): Promise<void> {
  const normalized = normalizeWhitespace(label);
  if (!normalized) return;

  try {
    const labelEmbedding = await embed(normalized);
    await supabase
      .from("links")
      .update({
        label: normalized,
        label_embedding: labelEmbedding,
      })
      .eq("id", linkId);
  } catch (error) {
    console.warn(`[links] failed to embed label for ${linkId}: ${error instanceof Error ? error.message : String(error)}`);
    await supabase
      .from("links")
      .update({ label: normalized })
      .eq("id", linkId);
  }
}

async function findExistingClarification(context: Record<string, unknown>): Promise<string | null> {
  const mention = String(context.mention ?? "").toLowerCase();
  const candidateEntityId = String(context.candidateEntityId ?? "");
  const candidateEntityIds = new Set(
    Array.isArray(context.candidateEntityIds)
      ? context.candidateEntityIds.map((id) => String(id))
      : [],
  );

  const { data, error } = await supabase
    .from("clarification_queue")
    .select("id, context")
    .in("status", ["pending", "asked"])
    .limit(100);

  if (error || !data) return null;

  for (const row of data as Array<Record<string, unknown>>) {
    const existing = metadataRecord(row.context);
    if (String(existing.type ?? "") !== String(context.type ?? "")) continue;
    if (mention && String(existing.mention ?? "").toLowerCase() !== mention) continue;

    const existingCandidateId = String(existing.candidateEntityId ?? "");
    if (candidateEntityId && existingCandidateId === candidateEntityId) {
      return String(row.id);
    }

    const existingCandidateIds = Array.isArray(existing.candidateEntityIds)
      ? existing.candidateEntityIds.map((id) => String(id))
      : [];
    if (candidateEntityIds.size > 0 && existingCandidateIds.some((id) => candidateEntityIds.has(id))) {
      return String(row.id);
    }
  }

  return null;
}

function isCandidateRelatedLink(row: Record<string, unknown>, blockId: string, mention: string): boolean {
  if (String(row.link_type ?? "") !== "related") return false;
  if (String(row.from_type ?? "") !== "user_block") return false;
  if (String(row.from_id ?? "") !== blockId) return false;
  const metadata = metadataRecord(row.metadata);
  return metadata.trigger === "email_target" && metadata.candidate_match === true && String(metadata.mention ?? "") === mention;
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

const EMAIL_TARGET_STOPWORDS = new Set([
  // Pronouns
  "me", "him", "her", "them", "us", "you", "it", "he", "she", "they", "we", "i",
  // Common verbs
  "is", "was", "has", "have", "had", "been", "being", "sent", "send", "sending",
  "said", "saying", "wrote", "written", "get", "got", "make", "made", "do", "does",
  "did", "done", "go", "going", "gone", "will", "would", "should", "could", "can",
  "may", "might", "shall",
  // Prepositions/conjunctions
  "for", "from", "to", "at", "in", "on", "by", "with", "without", "about", "of",
  "as", "or", "and", "but", "not", "so", "if", "then", "than", "that", "this",
  "the", "an", "a",
  // Adverbs/adjectives
  "well", "also", "too", "again", "already", "just", "now", "here", "there", "back",
  "up", "down", "out", "off", "over", "away", "tonight", "today", "tomorrow", "yesterday",
  // Technical terms
  "authentication", "authorization", "verification", "notification", "confirmation",
  "configuration", "integration", "implementation", "subscription", "registration",
  "password", "server", "client", "address", "account", "inbox", "outbox", "draft",
  "thread", "reply", "forward", "bounce", "spam", "attachment",
  // Other common non-name words
  "showing", "attending", "everyone", "anyone", "someone", "nobody", "everybody",
  "something", "nothing", "everything", "anything",
]);

function extractEmailTarget(content: string): string | null {
  const match = content.match(/\bemail\s+([a-z][a-z]+(?:\s+[a-z][a-z]+)?)/i);
  if (!match) return null;
  const extracted = normalizeWhitespace(match[1]);
  const words = extracted.toLowerCase().split(/\s+/);
  if (words.some((w) => EMAIL_TARGET_STOPWORDS.has(w))) return null;
  return extracted;
}

async function createMuaQuestionBlock(question: string, context: Record<string, unknown>): Promise<void> {
  const dedupeKey = await hashText(`clarification:${normalizeWhitespace(question)}`);
  await createMuaBlock({
    content: question,
    visibility: "private",
    source: "system",
    metadata: { kind: "clarification", ...context },
    blockKind: "note",
    dedupeKey,
  });
}

async function maybeQueueEntityDisambiguation(blockId: string, content: string): Promise<void> {
  const target = extractEmailTarget(content);
  if (!target) return;

  const matches = await findEntitiesLoose(target);
  if (matches.length === 1) {
    await insertLink({
      fromType: "user_block",
      fromId: blockId,
      toType: "entity",
      toId: matches[0].id,
      linkType: "about",
      metadata: { trigger: "email_target" },
    });
    return;
  }

  if (matches.length > 1) {
    const opts: ClarificationOption[] = matches.map((m) => ({
      label: m.name,
      value: `entity:${m.id}`,
    }));
    opts.push({ label: `new person: ${target}`, value: `new:${target}` });
    opts.push({ label: "none of these", value: "dismiss" });

    const q = `for "email ${target}", which person did you mean?`;
    const clarificationContext = {
      type: "person_disambiguation",
      mention: target,
      blockId,
      candidateEntityIds: matches.map((m) => m.id),
    };
    const existingClarificationId = await findExistingClarification(clarificationContext);
    const clarificationId = existingClarificationId ?? await queueClarification({
      question: q,
      options: opts,
      context: clarificationContext,
      priority: "high",
    });

    if (clarificationId) {
      await createMuaQuestionBlock(q, { clarificationId, blockId, mention: target });
    }
    return;
  }

  const candidateId = await createEntityCandidate(target);
  if (!candidateId) return;

  await insertLink({
    fromType: "user_block",
    fromId: blockId,
    toType: "entity",
    toId: candidateId,
    linkType: "related",
    metadata: { trigger: "email_target", mention: target, candidate_match: true },
  });

  const q = `you wrote "email ${target}". should i treat ${target} as a new person?`;
  const clarificationContext = {
    type: "person_new_confirm",
    mention: target,
    blockId,
    candidateEntityId: candidateId,
  };
  const existingClarificationId = await findExistingClarification(clarificationContext);
  const clarificationId = existingClarificationId ?? await queueClarification({
    question: q,
    options: [
      { label: `yes, create ${target}`, value: `confirm_new:${candidateId}` },
      { label: "no, ignore this", value: "dismiss" },
    ],
    context: clarificationContext,
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
  sourceRef?: SourceRef | Record<string, unknown>;
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
  sourceRef?: SourceRef | Record<string, unknown>;
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
  visibility?: BlockVisibility;
  source?: BlockSource;
  sourceRef?: SourceRef | Record<string, unknown>;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}): Promise<BlockInsertResult> {
  if (!input.content.trim()) throw new Error("MUA block content cannot be empty");
  const blockKind = input.blockKind ?? "note";
  const metadataInput = metadataRecord(input.metadata);
  const normalizedMetadata = blockKind === "action_open"
    ? validateMuaMetadata(blockKind, metadataInput)
    : validateMuaMetadata(blockKind, metadataInput);
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
      block_kind: blockKind,
      visibility: input.visibility ?? "private",
      source,
      source_ref: sourceRef,
      metadata: normalizedMetadata,
      dedupe_key: input.dedupeKey ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`createMuaBlock failed: ${error?.message ?? "unknown error"}`);
  }

  const id = (data as { id: string }).id;
  await upsertBlockEmbedding({ blockType: "mua", blockId: id, text: input.content }).catch(() => {});
  return { id, content: input.content, metadata: normalizedMetadata };
}

async function updateMuaBlockMetadata(
  blockId: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const { data: existing, error } = await supabase
    .from("mua_blocks")
    .select("id, metadata")
    .eq("id", blockId)
    .maybeSingle();
  if (error || !existing) return null;

  const currentMetadata = metadataRecord((existing as { metadata?: unknown }).metadata);
  const nextMetadata = updater(currentMetadata);
  await supabase
    .from("mua_blocks")
    .update({
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", blockId);
  return nextMetadata;
}

export async function ackAction(blockId: string): Promise<void> {
  await updateMuaBlockMetadata(blockId, (current) => {
    const nextMetadata = {
      ...current,
      last_acknowledged_at: new Date().toISOString(),
    };
    return validateMuaMetadata("action_open", nextMetadata);
  });
}

export async function closeAction(
  blockId: string,
  options?: { closedReason?: ActionClosedReason; closedAt?: string },
): Promise<void> {
  const closedAt = options?.closedAt ?? new Date().toISOString();
  const nextMetadata = await updateMuaBlockMetadata(blockId, (current) => validateMuaMetadata("action_closed", {
    ...current,
    closed_reason: options?.closedReason,
    closed_at: closedAt,
  }));

  await supabase
    .from("mua_blocks")
    .update({
      block_kind: "action_closed",
      metadata: nextMetadata ?? validateMuaMetadata("action_closed", {
        closed_reason: options?.closedReason,
        closed_at: closedAt,
      }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", blockId)
    .eq("block_kind", "action_open");
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
    const mention = String(row.context.mention ?? "");
    if (blockId && choice.value.startsWith("entity:")) {
      const entityId = choice.value.slice("entity:".length);
      const { data: linksToDelete } = await supabase
        .from("links")
        .select("id, from_type, from_id, link_type, metadata")
        .eq("from_type", "user_block")
        .eq("from_id", blockId)
        .eq("link_type", "related");

      const tempLinkIds = ((linksToDelete ?? []) as Array<Record<string, unknown>>)
        .filter((link) => isCandidateRelatedLink(link, blockId, mention));

      if (tempLinkIds.length > 0) {
        await supabase.from("links").delete().in("id", tempLinkIds.map((link) => String(link.id)));
      }

      await insertLink({
        fromType: "user_block",
        fromId: blockId,
        toType: "entity",
        toId: entityId,
        linkType: "about",
        metadata: { resolved_by: "clarify" },
      });
    } else if (blockId && choice.value.startsWith("new:")) {
      const mention = choice.value.slice("new:".length);
      const entityId = await createEntityCandidate(mention);
      if (entityId) {
        await insertLink({
          fromType: "user_block",
          fromId: blockId,
          toType: "entity",
          toId: entityId,
          linkType: "about",
          metadata: { resolved_by: "clarify_new" },
        });
      }
    }
  }

  if (contextType === "person_new_confirm") {
    const blockId = String(row.context.blockId ?? "");
    const mention = String(row.context.mention ?? "");
    if (choice.value.startsWith("confirm_new:")) {
      const entityId = choice.value.slice("confirm_new:".length);
      if (blockId) {
        const { data: linksToDelete } = await supabase
          .from("links")
          .select("id, from_type, from_id, link_type, metadata")
          .eq("from_type", "user_block")
          .eq("from_id", blockId)
          .eq("link_type", "related")
          .eq("to_id", entityId);

        const tempLinkIds = ((linksToDelete ?? []) as Array<Record<string, unknown>>)
          .filter((link) => isCandidateRelatedLink(link, blockId, mention))
          .map((link) => String(link.id));
        if (tempLinkIds.length > 0) {
          await supabase.from("links").delete().in("id", tempLinkIds);
        }

        await insertLink({
          fromType: "user_block",
          fromId: blockId,
          toType: "entity",
          toId: entityId,
          linkType: "about",
          metadata: { resolved_by: "clarify_confirm" },
        });
      }
    } else if (choice.value === "dismiss" && blockId) {
      const candidateEntityId = String(row.context.candidateEntityId ?? "");
      const { data: linksToDelete } = await supabase
        .from("links")
        .select("id, from_type, from_id, link_type, metadata")
        .eq("from_type", "user_block")
        .eq("from_id", blockId)
        .eq("link_type", "related")
        .eq("to_id", candidateEntityId);
      const tempLinkIds = ((linksToDelete ?? []) as Array<Record<string, unknown>>)
        .filter((link) => isCandidateRelatedLink(link, blockId, mention))
        .map((link) => String(link.id));
      if (tempLinkIds.length > 0) {
        await supabase.from("links").delete().in("id", tempLinkIds);
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

function sanitizeProcessorBlocks(input: ProcessorMuaBlockDraft[]): ProcessorMuaBlockDraft[] {
  const out: ProcessorMuaBlockDraft[] = [];
  for (const row of input) {
    const content = normalizeWhitespace(String(row.content ?? ""));
    if (!content) continue;
    out.push({
      content: content.slice(0, 3000),
      block_kind: row.block_kind ?? "note",
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

  const foundIds = new Set((data as Array<Record<string, unknown>>).map((row) => String(row.id)));
  const missingIds = ids.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    await supabase
      .from("processing_state")
      .delete()
      .eq("subject_type", "user_block")
      .in("subject_id", missingIds);
  }

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

  const foundIds = new Set((data as Array<Record<string, unknown>>).map((row) => String(row.id)));
  const missingIds = ids.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    await supabase
      .from("processing_state")
      .delete()
      .eq("subject_type", "artifact")
      .in("subject_id", missingIds);
  }

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
    "- Use `block_kind`=`action_open` ONLY for concrete tasks the user needs to act on (e.g., 'email someone', 'schedule a meeting', 'submit a draft'). Do NOT use action_open for questions, observations, musings, or information the user shared. When in doubt, use note. Default to note.",
    "- `related_blocks` must only use ids from candidate_related_blocks. Add a short optional label when the connection meaning is clear.",
    "- `entity_names` should include significant proper nouns: people, projects, organizations, places, products, or other concrete named things.",
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

  const result = await runLLM({
    task: "block_processor",
    prompt,
    cwd: SYSTEM_CWD,
    ephemeral: true,
    maxTurns: 4,
    timeoutMs: 120_000,
    jsonSchema: BLOCK_PROCESS_SCHEMA,
  });
  const parsed = parseStructuredOutput<BlockProcessResult>(result.structuredOutput ?? result.text);
  if (!parsed) throw new Error("block processor returned invalid structured output");
  return {
    analysis: normalizeWhitespace(String(parsed.analysis ?? "")),
    mua_blocks: sanitizeProcessorBlocks(Array.isArray(parsed.mua_blocks) ? parsed.mua_blocks : []),
    related_blocks: Array.isArray(parsed.related_blocks)
      ? parsed.related_blocks.map((row) => ({
          id: String(row.id ?? ""),
          label: typeof row.label === "string" ? String(row.label) : undefined,
        }))
      : [],
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
    "- Use `block_kind`=`action_open` ONLY for concrete tasks the user needs to act on (e.g., 'email someone', 'schedule a meeting', 'submit a draft'). Do NOT use action_open for questions, observations, musings, or information the user shared. When in doubt, use note. Default to note.",
    "- `entity_names` should include significant proper nouns: people, projects, organizations, places, products, or other concrete named things.",
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

  const result = await runLLM({
    task: "artifact_processor",
    prompt,
    cwd: SYSTEM_CWD,
    ephemeral: true,
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
  relatedBlocks?: RelatedBlockDraft[];
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
      metadata: { processor_version: PROCESSOR_VERSION, source: "state_processor" },
    });

    for (const relatedBlock of input.relatedBlocks ?? []) {
      if (!relatedBlock.id) continue;
      await insertLink({
        fromType: "mua_block",
        fromId: block.id,
        toType: "user_block",
        toId: relatedBlock.id,
        linkType: "related",
        label: relatedBlock.label,
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
        metadata: { processor_version: PROCESSOR_VERSION, source: "state_processor" },
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
      const entity = await ensureEntity(entityName);
      if (!entity) continue;
      entityIds.push(entity.id);
      await insertLink({
        fromType: "user_block",
        fromId: row.id,
        toType: "entity",
        toId: entity.id,
        linkType: "about",
        metadata: { processor_version: PROCESSOR_VERSION, source: "state_processor", entity_name: entityName },
      });
    }

    const relatedBlocks = output.related_blocks
      .map((relatedBlock) => ({
        id: relatedBlock.id,
        label: relatedBlock.label,
      }))
      .filter((relatedBlock) => relatedBlock.id && relatedBlock.id !== row.id)
      .slice(0, 8);
    for (const relatedBlock of relatedBlocks) {
      await insertLink({
        fromType: "user_block",
        fromId: row.id,
        toType: "user_block",
        toId: relatedBlock.id,
        linkType: "related",
        label: relatedBlock.label,
        metadata: { processor_version: PROCESSOR_VERSION, source: "state_processor" },
      });
    }

    const createdMuaBlocks = await createProcessorMuaBlocks({
      drafts: output.mua_blocks,
      metadata: {
        processor_version: PROCESSOR_VERSION,
        source: "state_processor",
        source_user_block_id: row.id,
        analysis: output.analysis,
        type: "block_processor",
      },
      derivedFrom: { type: "user_block", id: row.id },
      relatedBlocks,
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
      const entity = await ensureEntity(entityName);
      if (!entity) continue;
      entityIds.push(entity.id);
      await insertLink({
        fromType: "artifact",
        fromId: row.id,
        toType: "entity",
        toId: entity.id,
        linkType: "about",
        metadata: { processor_version: PROCESSOR_VERSION, source: "state_processor", entity_name: entityName },
      });
    }

    const createdDescription = output.description
      ? await createProcessorMuaBlocks({
          drafts: [
            {
              content: output.description,
              block_kind: "note",
            },
          ],
          metadata: {
            processor_version: PROCESSOR_VERSION,
            source: "state_processor",
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
        source: "state_processor",
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
    .select("id, name, aliases")
    .order("updated_at", { ascending: false })
    .limit(200);
  const { data: entitiesData } = await entityQuery;
  let entities = (entitiesData ?? []) as Array<Record<string, unknown>>;
  if (input?.peopleFilter && input.peopleFilter.trim()) {
    const token = input.peopleFilter.trim().toLowerCase();
    entities = entities.filter((e) => {
      const canonical = String(e.name ?? "").toLowerCase();
      if (canonical.includes(token)) return true;
      const aliases = (e.aliases as string[] | undefined) ?? [];
      return aliases.some((a) => a.toLowerCase().includes(token));
    });
  }
  const summaries: CrmPersonSummary[] = [];

  for (const entity of entities) {
    const entityId = String(entity.id);
    const name = String(entity.name);

    const { data: linksData } = await supabase
      .from("links")
      .select("from_type, from_id, link_type")
      .eq("to_type", "entity")
      .eq("to_id", entityId)
      .in("link_type", ["about", "related"])
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

function previewContent(text: string, max = 300): string {
  const normalized = normalizeWhitespace(text);
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function isoWeekKey(date = new Date()): string {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

async function fetchEntityTouchCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const batchSize of [5000]) {
    const { data } = await supabase
      .from("links")
      .select("from_type, from_id, to_type, to_id")
      .limit(batchSize);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      if (String(row.from_type ?? "") === "entity") {
        const id = String(row.from_id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      if (String(row.to_type ?? "") === "entity") {
        const id = String(row.to_id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    break;
  }
  return counts;
}

async function appendEntityAlias(entityId: string, alias: string): Promise<boolean> {
  const normalized = normalizeWhitespace(alias);
  if (!normalized) return false;

  const { data } = await supabase
    .from("entities")
    .select("id, aliases")
    .eq("id", entityId)
    .maybeSingle();
  if (!data) return false;

  const row = data as { aliases?: string[] };
  const aliases = new Set<string>(row.aliases ?? []);
  if ([...aliases].some((existing) => existing.toLowerCase() === normalized.toLowerCase())) {
    return false;
  }

  aliases.add(normalized);
  await supabase
    .from("entities")
    .update({
      aliases: [...aliases].slice(0, 64),
      updated_at: new Date().toISOString(),
    })
    .eq("id", entityId);
  return true;
}

async function markMergeCandidateBlockStatus(
  blockId: string,
  status: "pending" | "resolved" | "rejected",
): Promise<void> {
  await updateMuaBlockMetadata(blockId, (current) => {
    const next = {
      ...current,
      review_status: status,
      reviewed_at: new Date().toISOString(),
    };
    const parsed = MergeCandidateMeta.safeParse(next);
    if (!parsed.success) {
      warnMetadataValidation("merge_candidate", parsed.error.issues.map((issue) => issue.message).join("; "));
      return next;
    }
    return parsed.data;
  });
}

async function createReviewNote(input: {
  jobId: string;
  content: string;
  type: string;
  source: Exclude<ReviewSource, "state_processor">;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}): Promise<string> {
  const result = await createMuaBlock({
    content: input.content,
    blockKind: "note",
    source: "job",
    sourceRef: {
      v: 1,
      type: "job_run",
      id: { job_name: input.jobId },
      extras: {},
    },
    metadata: {
      source: input.source,
      type: input.type,
      ...(input.metadata ?? {}),
    },
    dedupeKey: input.dedupeKey,
  });
  return result.id;
}

async function fetchPendingMergeCandidateBlocks(limit = 200): Promise<Array<Record<string, unknown>>> {
  const { data } = await supabase
    .from("mua_blocks")
    .select("id, content, metadata, created_at")
    .eq("source", "job")
    .eq("block_kind", "note")
    .order("created_at", { ascending: false })
    .limit(limit);

  return ((data ?? []) as Array<Record<string, unknown>>).filter((row) => {
    const metadata = metadataRecord(row.metadata);
    if (metadata.type !== "merge_candidate") return false;
    const status = String(metadata.review_status ?? "pending");
    return status === "pending";
  });
}

async function fetchEndpointPreviews(
  refs: Array<{ type: string; id: string }>,
): Promise<Map<string, string>> {
  const unique = new Map<string, { type: string; id: string }>();
  for (const ref of refs) {
    unique.set(`${ref.type}:${ref.id}`, ref);
  }

  const byType = new Map<string, string[]>();
  for (const ref of unique.values()) {
    const ids = byType.get(ref.type) ?? [];
    ids.push(ref.id);
    byType.set(ref.type, ids);
  }

  const previews = new Map<string, string>();

  for (const [type, ids] of byType) {
    if (type === "user_block" || type === "mua_block") {
      const table = type === "user_block" ? "user_blocks" : "mua_blocks";
      for (const part of chunk(ids, 100)) {
        const { data } = await supabase
          .from(table)
          .select("id, content")
          .in("id", part);
        for (const row of (data ?? []) as Array<Record<string, unknown>>) {
          previews.set(`${type}:${String(row.id)}`, previewContent(String(row.content ?? "")));
        }
      }
      continue;
    }

    if (type === "entity") {
      for (const part of chunk(ids, 100)) {
        const { data } = await supabase
          .from("entities")
          .select("id, name")
          .in("id", part);
        for (const row of (data ?? []) as Array<Record<string, unknown>>) {
          previews.set(`${type}:${String(row.id)}`, String(row.name ?? ""));
        }
      }
      continue;
    }

    if (type === "artifact") {
      for (const part of chunk(ids, 100)) {
        const { data } = await supabase
          .from("artifacts")
          .select("id, title, text_content")
          .in("id", part);
        for (const row of (data ?? []) as Array<Record<string, unknown>>) {
          const preview = String(row.title ?? "") || previewContent(String(row.text_content ?? ""));
          previews.set(`${type}:${String(row.id)}`, preview);
        }
      }
    }
  }

  return previews;
}

async function applyMissedLinks(
  drafts: ReviewMissedLinkDraft[],
  source: Exclude<ReviewSource, "state_processor">,
): Promise<number> {
  let applied = 0;
  for (const draft of drafts) {
    const entity = await ensureEntity(draft.entity_name);
    if (!entity) continue;
    const linkId = await insertLink({
      fromType: draft.block_type,
      fromId: draft.block_id,
      toType: "entity",
      toId: entity.id,
      linkType: "about",
      metadata: { source },
    });
    if (linkId) applied++;
  }
  return applied;
}

async function applyAliasUpdates(drafts: ReviewAliasUpdateDraft[]): Promise<number> {
  let applied = 0;
  for (const draft of drafts) {
    if (await appendEntityAlias(draft.entity_id, draft.new_alias)) applied++;
  }
  return applied;
}

async function applyNewConnections(
  drafts: ReviewConnectionDraft[],
  source: Exclude<ReviewSource, "state_processor">,
): Promise<number> {
  let applied = 0;
  for (const draft of drafts) {
    const linkId = await insertLink({
      fromType: draft.from_type,
      fromId: draft.from_id,
      toType: draft.to_type,
      toId: draft.to_id,
      linkType: "related",
      label: draft.label,
      metadata: { source },
    });
    if (linkId) applied++;
  }
  return applied;
}

export async function mergeEntities(
  keepId: string,
  mergeId: string,
  options?: { mergeCandidateBlockId?: string },
): Promise<void> {
  if (!keepId || !mergeId || keepId === mergeId) return;

  const { data: entities } = await supabase
    .from("entities")
    .select("id, name, aliases")
    .in("id", [keepId, mergeId]);
  const rows = (entities ?? []) as Array<Record<string, unknown>>;
  const keep = rows.find((row) => String(row.id) === keepId);
  const merge = rows.find((row) => String(row.id) === mergeId);
  if (!keep || !merge) return;

  const aliases = new Set<string>([
    ...(((keep.aliases as string[] | undefined) ?? [])),
    ...(((merge.aliases as string[] | undefined) ?? [])),
    String(merge.name ?? ""),
  ].filter(Boolean));

  await supabase
    .from("entities")
    .update({
      aliases: [...aliases].slice(0, 64),
      updated_at: new Date().toISOString(),
    })
    .eq("id", keepId);

  await supabase
    .from("links")
    .update({ from_id: keepId })
    .eq("from_type", "entity")
    .eq("from_id", mergeId);

  await supabase
    .from("links")
    .update({ to_id: keepId })
    .eq("to_type", "entity")
    .eq("to_id", mergeId);

  const { data: impactedLinks } = await supabase
    .from("links")
    .select("id, from_type, from_id, to_type, to_id, link_type, label, created_at")
    .or(`and(from_type.eq.entity,from_id.eq.${keepId}),and(to_type.eq.entity,to_id.eq.${keepId})`)
    .limit(2000);

  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of (impactedLinks ?? []) as Array<Record<string, unknown>>) {
    const key = [
      String(row.from_type ?? ""),
      String(row.from_id ?? ""),
      String(row.to_type ?? ""),
      String(row.to_id ?? ""),
      String(row.link_type ?? ""),
    ].join("|");
    const items = grouped.get(key) ?? [];
    items.push(row);
    grouped.set(key, items);
  }

  for (const rowsForKey of grouped.values()) {
    if (rowsForKey.length <= 1) continue;
    rowsForKey.sort((a, b) => {
      const aHasLabel = String(a.label ?? "").trim().length > 0 ? 1 : 0;
      const bHasLabel = String(b.label ?? "").trim().length > 0 ? 1 : 0;
      if (bHasLabel !== aHasLabel) return bHasLabel - aHasLabel;
      return new Date(String(b.created_at ?? "")).getTime() - new Date(String(a.created_at ?? "")).getTime();
    });
    const duplicateIds = rowsForKey.slice(1).map((row) => String(row.id));
    if (duplicateIds.length > 0) {
      await supabase.from("links").delete().in("id", duplicateIds);
    }
  }

  await supabase.from("entities").delete().eq("id", mergeId);

  if (options?.mergeCandidateBlockId) {
    await markMergeCandidateBlockStatus(options.mergeCandidateBlockId, "resolved");
  }

  await logSystemEvent({
    level: "info",
    component: "system",
    eventType: "entity_merged",
    message: `Merged entity ${mergeId} into ${keepId}`,
    payload: { keepId, mergeId },
  }).catch(() => {});
}

export async function runBoardHourlyReview(input: {
  jobId: string;
  lastRunAt?: number | null;
}): Promise<HourlyReviewResult> {
  const lastRunTimestamp = input.lastRunAt ? new Date(input.lastRunAt).toISOString() : null;
  const since24h = new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString();

  const [muaBlocksRes, userBlocksRes, entitiesRes, linksRes] = await Promise.all([
    supabase
      .from("mua_blocks")
      .select("id, content, block_kind, created_at, metadata")
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("user_blocks")
      .select("id, content, created_at, source")
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("entities")
      .select("id, name, aliases")
      .order("updated_at", { ascending: false })
      .limit(500),
    supabase
      .from("links")
      .select("id, from_type, from_id, to_type, to_id, link_type, label, created_at")
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  const prompt = [
    "You are Muavin's hourly board review.",
    "Use the JSON context to identify recurring tags, missed entity links, alias updates, and merge candidates.",
    "Focus analysis on blocks created after the last run timestamp. Earlier blocks are context only.",
    "",
    `last_run_timestamp: ${lastRunTimestamp ?? "never"}`,
    "",
    "mua_blocks_last_24h:",
    JSON.stringify(muaBlocksRes.data ?? [], null, 2),
    "",
    "user_blocks_last_24h:",
    JSON.stringify(userBlocksRes.data ?? [], null, 2),
    "",
    "entities:",
    JSON.stringify(entitiesRes.data ?? [], null, 2),
    "",
    "links_last_24h:",
    JSON.stringify(linksRes.data ?? [], null, 2),
  ].join("\n");

  const llmResult = await runLLM({
    task: "board_hourly_review",
    prompt,
    cwd: SYSTEM_CWD,
    ephemeral: true,
    maxTurns: 5,
    timeoutMs: 300_000,
    jsonSchema: HOURLY_REVIEW_SCHEMA,
  });

  const parsed = parseStructuredOutput<HourlyReviewOutput>(llmResult.structuredOutput ?? llmResult.text);
  if (!parsed) throw new Error("hourly review returned invalid structured output");

  let createdTags = 0;
  for (const tag of parsed.new_tags ?? []) {
    const entity = await ensureEntity(tag.name);
    if (entity) createdTags++;
  }

  const missedLinks = await applyMissedLinks(parsed.missed_links ?? [], "hourly_review");
  const aliasUpdates = await applyAliasUpdates(parsed.alias_updates ?? []);

  let mergeCandidates = 0;
  for (const candidate of parsed.merge_candidates ?? []) {
    const dedupeKey = await hashText(
      `merge_candidate:${candidate.entity_id_keep}:${candidate.entity_id_merge}:${normalizeWhitespace(candidate.reason)}`,
    );
    await createReviewNote({
      jobId: input.jobId,
      content: `Merge candidate: ${candidate.reason}`,
      type: "merge_candidate",
      source: "hourly_review",
      dedupeKey,
      metadata: {
        entity_id_keep: candidate.entity_id_keep,
        entity_id_merge: candidate.entity_id_merge,
        reason: candidate.reason,
        review_status: "pending",
      },
    });
    mergeCandidates++;
  }

  return {
    createdTags,
    missedLinks,
    aliasUpdates,
    mergeCandidates,
    summary: normalizeWhitespace(parsed.summary || `hourly review: tags=${createdTags}, missed_links=${missedLinks}, aliases=${aliasUpdates}, merge_candidates=${mergeCandidates}`),
  };
}

export async function runBoardDailyReview(input: {
  jobId: string;
  lastRunAt?: number | null;
}): Promise<DailyReviewResult> {
  const since30d = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString();
  const entityTouchCounts = await fetchEntityTouchCounts();
  const pendingMergeCandidates = await fetchPendingMergeCandidateBlocks(200);

  const [entitiesRes, recentMuaRes, unlabeledLinksRes] = await Promise.all([
    supabase
      .from("entities")
      .select("id, name, aliases, created_at")
      .order("updated_at", { ascending: false })
      .limit(500),
    supabase
      .from("mua_blocks")
      .select("id, content, block_kind, created_at")
      .gte("created_at", since30d)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("links")
      .select("id, from_type, from_id, to_type, to_id, link_type, label, created_at")
      .eq("link_type", "related")
      .gte("created_at", since30d)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const unlabeledLinks = ((unlabeledLinksRes.data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => !String(row.label ?? "").trim());
  const endpointPreviews = await fetchEndpointPreviews([
    ...unlabeledLinks.map((row) => ({ type: String(row.from_type), id: String(row.from_id) })),
    ...unlabeledLinks.map((row) => ({ type: String(row.to_type), id: String(row.to_id) })),
  ]);

  const linkContext = unlabeledLinks.map((row) => ({
    id: String(row.id),
    from_type: String(row.from_type),
    from_id: String(row.from_id),
    to_type: String(row.to_type),
    to_id: String(row.to_id),
    from_preview: endpointPreviews.get(`${String(row.from_type)}:${String(row.from_id)}`) ?? "",
    to_preview: endpointPreviews.get(`${String(row.to_type)}:${String(row.to_id)}`) ?? "",
  }));

  const entitiesWithCounts = ((entitiesRes.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    link_count: entityTouchCounts.get(String(row.id)) ?? 0,
  }));

  const prompt = [
    "You are Muavin's daily board review.",
    "Review entity merge candidates, tag operations, new semantic connections, and label enrichment for unlabeled related links.",
    "",
    "entities:",
    JSON.stringify(entitiesWithCounts, null, 2),
    "",
    "pending_merge_candidates:",
    JSON.stringify(pendingMergeCandidates, null, 2),
    "",
    "mua_blocks_last_30d:",
    JSON.stringify(((recentMuaRes.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: row.id,
      content_preview: previewContent(String(row.content ?? "")),
      block_kind: row.block_kind,
      created_at: row.created_at,
    })), null, 2),
    "",
    "unlabeled_related_links:",
    JSON.stringify(linkContext, null, 2),
  ].join("\n");

  const llmResult = await runLLM({
    task: "board_daily_review",
    prompt,
    cwd: SYSTEM_CWD,
    ephemeral: true,
    maxTurns: 5,
    timeoutMs: 600_000,
    jsonSchema: DAILY_REVIEW_SCHEMA,
  });

  const parsed = parseStructuredOutput<DailyReviewOutput>(llmResult.structuredOutput ?? llmResult.text);
  if (!parsed) throw new Error("daily review returned invalid structured output");

  const acceptedMerges = new Set((parsed.merges ?? []).map((merge) => `${merge.keep_id}:${merge.merge_id}`));
  let merges = 0;
  let rejectedMergeCandidates = 0;
  for (const block of pendingMergeCandidates) {
    const metadata = metadataRecord(block.metadata);
    const keepId = String(metadata.entity_id_keep ?? "");
    const mergeId = String(metadata.entity_id_merge ?? "");
    const key = `${keepId}:${mergeId}`;
    if (acceptedMerges.has(key)) {
      await mergeEntities(keepId, mergeId, { mergeCandidateBlockId: String(block.id) });
      merges++;
    } else {
      await markMergeCandidateBlockStatus(String(block.id), "rejected");
      rejectedMergeCandidates++;
    }
  }

  let tagOps = 0;
  for (const op of parsed.tag_ops ?? []) {
    if (op.op === "rename" && op.new_name) {
      await supabase
        .from("entities")
        .update({
          name: normalizeEntityName(op.new_name),
          updated_at: new Date().toISOString(),
        })
        .eq("id", op.entity_id);
      tagOps++;
      continue;
    }
    if (op.op === "merge" && op.merge_into_id) {
      await mergeEntities(op.merge_into_id, op.entity_id);
      tagOps++;
    }
  }

  const newConnections = await applyNewConnections(parsed.new_connections ?? [], "daily_review");

  let labelUpdates = 0;
  for (const update of parsed.label_updates ?? []) {
    const linkRow = unlabeledLinks.find((row) => String(row.id) === update.link_id);
    if (!linkRow) continue;
    await setLinkLabel(update.link_id, update.label);
    labelUpdates++;
  }

  return {
    merges,
    rejectedMergeCandidates,
    tagOps,
    newConnections,
    labelUpdates,
    summary: normalizeWhitespace(parsed.summary || `daily review: merges=${merges}, rejected=${rejectedMergeCandidates}, tag_ops=${tagOps}, new_connections=${newConnections}, labels=${labelUpdates}`),
  };
}

export async function runBoardWeeklyReview(input: {
  jobId: string;
  lastRunAt?: number | null;
}): Promise<WeeklyReviewResult> {
  const entityTouchCounts = await fetchEntityTouchCounts();
  const [entitiesRes, openActionsRes, reviewBlocksRes, userCountRes, noteCountRes, openCountRes, closedCountRes, linksCountRes] = await Promise.all([
    supabase
      .from("entities")
      .select("id, name, aliases, created_at")
      .order("updated_at", { ascending: false })
      .limit(500),
    supabase
      .from("mua_blocks")
      .select("id, content, created_at, metadata")
      .eq("block_kind", "action_open")
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("mua_blocks")
      .select("id, metadata, created_at")
      .eq("source", "job")
      .gte("created_at", new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)).toISOString())
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("user_blocks").select("*", { count: "exact", head: true }),
    supabase.from("mua_blocks").select("*", { count: "exact", head: true }).eq("block_kind", "note"),
    supabase.from("mua_blocks").select("*", { count: "exact", head: true }).eq("block_kind", "action_open"),
    supabase.from("mua_blocks").select("*", { count: "exact", head: true }).eq("block_kind", "action_closed"),
    supabase.from("links").select("*", { count: "exact", head: true }),
  ]);

  const entitiesWithCounts = ((entitiesRes.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    link_count: entityTouchCounts.get(String(row.id)) ?? 0,
  }));
  const openActions = ((openActionsRes.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    metadata: row.metadata,
    last_acknowledged_at: extractLastAcknowledgedAt(metadataRecord(row.metadata)),
  }));
  const prompt = [
    "You are Muavin's weekly board review.",
    "Review the graph for safe pruning, stale actions, structural cleanup, observations, and any lower-tier fixes worth applying now.",
    "",
    "entities:",
    JSON.stringify(entitiesWithCounts, null, 2),
    "",
    "open_actions:",
    JSON.stringify(openActions, null, 2),
    "",
    "aggregate_stats:",
    JSON.stringify({
      total_user_blocks: userCountRes.count ?? 0,
      total_mua_blocks_note: noteCountRes.count ?? 0,
      total_mua_blocks_action_open: openCountRes.count ?? 0,
      total_mua_blocks_action_closed: closedCountRes.count ?? 0,
      total_entities: entitiesWithCounts.length,
      total_links: linksCountRes.count ?? 0,
    }, null, 2),
    "",
    "review_blocks_last_7d:",
    JSON.stringify(reviewBlocksRes.data ?? [], null, 2),
  ].join("\n");

  const llmResult = await runLLM({
    task: "board_weekly_review",
    prompt,
    cwd: SYSTEM_CWD,
    ephemeral: true,
    maxTurns: 6,
    timeoutMs: 600_000,
    jsonSchema: WEEKLY_REVIEW_SCHEMA,
  });

  const parsed = parseStructuredOutput<WeeklyReviewOutput>(llmResult.structuredOutput ?? llmResult.text);
  if (!parsed) throw new Error("weekly review returned invalid structured output");

  let pruned = 0;
  for (const draft of parsed.prune ?? []) {
    if ((entityTouchCounts.get(draft.entity_id) ?? 0) > 0) continue;
    await supabase.from("links").delete().or(`and(from_type.eq.entity,from_id.eq.${draft.entity_id}),and(to_type.eq.entity,to_id.eq.${draft.entity_id})`);
    await supabase.from("entities").delete().eq("id", draft.entity_id);
    pruned++;
  }

  let closedActions = 0;
  let nudges = 0;
  for (const draft of parsed.stale_actions ?? []) {
    if (draft.suggestion === "close") {
      await closeAction(draft.block_id, { closedReason: "archived" });
      closedActions++;
      continue;
    }
    if (draft.suggestion === "nudge") {
      const action = openActions.find((row) => String(row.id) === draft.block_id);
      await createReviewNote({
        jobId: input.jobId,
        content: `Action may be stale: ${previewContent(String(action?.content ?? ""))}. Consider acting on it or archiving.`,
        type: "staleness_nudge",
        source: "weekly_review",
        metadata: { source_block_id: draft.block_id },
      });
      nudges++;
    }
  }

  let cleanupFixes = 0;
  for (const draft of parsed.cleanup ?? []) {
    if (draft.type === "link" && draft.action === "delete_orphan_link") {
      const { data } = await supabase
        .from("links")
        .select("id, from_type, from_id, to_type, to_id")
        .eq("id", draft.id)
        .maybeSingle();
      if (!data) continue;
      const link = data as Record<string, unknown>;
      const endpoints = await fetchEndpointPreviews([
        { type: String(link.from_type), id: String(link.from_id) },
        { type: String(link.to_type), id: String(link.to_id) },
      ]);
      if (!endpoints.get(`${String(link.from_type)}:${String(link.from_id)}`) || !endpoints.get(`${String(link.to_type)}:${String(link.to_id)}`)) {
        await supabase.from("links").delete().eq("id", draft.id);
        cleanupFixes++;
      }
    }
  }

  let observations = 0;
  if (normalizeWhitespace(parsed.observations ?? "")) {
    const weekKey = isoWeekKey();
    const dedupeKey = await hashText(`weekly_observations:${weekKey}`);
    await createReviewNote({
      jobId: input.jobId,
      content: normalizeWhitespace(parsed.observations),
      type: "weekly_observations",
      source: "weekly_review",
      dedupeKey,
      metadata: { iso_week: weekKey },
    });
    observations++;
  }

  const aliasUpdates = await applyAliasUpdates(parsed.alias_updates ?? []);
  const missedLinks = await applyMissedLinks(parsed.missed_links ?? [], "weekly_review");
  const newConnections = await applyNewConnections(parsed.new_connections ?? [], "weekly_review");

  let mergeCandidates = 0;
  for (const candidate of parsed.merge_candidates ?? []) {
    const dedupeKey = await hashText(
      `merge_candidate:${candidate.entity_id_keep}:${candidate.entity_id_merge}:${normalizeWhitespace(candidate.reason)}`,
    );
    await createReviewNote({
      jobId: input.jobId,
      content: `Merge candidate: ${candidate.reason}`,
      type: "merge_candidate",
      source: "weekly_review",
      dedupeKey,
      metadata: {
        entity_id_keep: candidate.entity_id_keep,
        entity_id_merge: candidate.entity_id_merge,
        reason: candidate.reason,
        review_status: "pending",
      },
    });
    mergeCandidates++;
  }

  return {
    pruned,
    closedActions,
    nudges,
    cleanupFixes,
    observations,
    aliasUpdates,
    missedLinks,
    mergeCandidates,
    merges: 0,
    tagOps: 0,
    newConnections,
    summary: normalizeWhitespace(parsed.summary || `weekly review: pruned=${pruned}, closed=${closedActions}, nudges=${nudges}, cleanup=${cleanupFixes}, observations=${observations}, aliases=${aliasUpdates}, missed_links=${missedLinks}, merge_candidates=${mergeCandidates}, new_connections=${newConnections}`),
  };
}
