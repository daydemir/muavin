BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS user_blocks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  source TEXT NOT NULL DEFAULT 'cli',
  source_ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS user_block_versions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  block_id UUID NOT NULL REFERENCES user_blocks(id) ON DELETE CASCADE,
  version_no INT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  capture_reason TEXT NOT NULL CHECK (capture_reason IN ('create', 'autosave', 'finalize')),
  UNIQUE(block_id, version_no)
);

CREATE TABLE IF NOT EXISTS mua_blocks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  source TEXT NOT NULL DEFAULT 'system',
  source_ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  block_kind TEXT NOT NULL DEFAULT 'note' CHECK (block_kind IN ('note', 'action_open', 'action_closed')),
  confidence NUMERIC(5,4) DEFAULT NULL,
  dedupe_key TEXT DEFAULT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS entities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'company', 'place', 'school', 'department', 'program')),
  canonical_name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC(5,4) DEFAULT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS artifacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_type TEXT NOT NULL CHECK (source_type IN ('email', 'apple_note', 'apple_reminder', 'file')),
  external_id TEXT DEFAULT NULL,
  title TEXT DEFAULT NULL,
  mime_type TEXT DEFAULT NULL,
  text_content TEXT DEFAULT NULL,
  object_key TEXT DEFAULT NULL,
  checksum TEXT DEFAULT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ingest_status TEXT NOT NULL DEFAULT 'new' CHECK (ingest_status IN ('new', 'parsed', 'linked', 'error', 'skipped')),
  error TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS links (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  from_type TEXT NOT NULL CHECK (from_type IN ('user_block', 'mua_block', 'entity', 'artifact')),
  from_id UUID NOT NULL,
  to_type TEXT NOT NULL CHECK (to_type IN ('user_block', 'mua_block', 'entity', 'artifact')),
  to_id UUID NOT NULL,
  link_type TEXT NOT NULL CHECK (link_type IN ('references', 'about', 'derived_from', 'related', 'supersedes', 'mentions', 'candidate_match')),
  confidence NUMERIC(5,4) DEFAULT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS clarification_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  question TEXT NOT NULL,
  options JSONB NOT NULL,
  context JSONB NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'asked', 'answered', 'expired')),
  answer JSONB DEFAULT NULL,
  asked_at TIMESTAMPTZ DEFAULT NULL,
  answered_at TIMESTAMPTZ DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS processing_state (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user_block', 'artifact')),
  subject_id UUID NOT NULL,
  input_hash TEXT NOT NULL,
  last_processed_hash TEXT DEFAULT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'processed', 'error')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT DEFAULT NULL,
  processed_at TIMESTAMPTZ DEFAULT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS system_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error', 'critical')),
  component TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  run_id TEXT DEFAULT NULL,
  related_block_id UUID DEFAULT NULL,
  related_artifact_id UUID DEFAULT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS embedding_profiles (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS block_embeddings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  block_type TEXT NOT NULL CHECK (block_type IN ('user', 'mua')),
  block_id UUID NOT NULL,
  profile_id TEXT NOT NULL REFERENCES embedding_profiles(id) ON DELETE CASCADE,
  text_hash TEXT NOT NULL,
  embedding VECTOR(512) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(block_type, block_id, profile_id)
);

CREATE TABLE IF NOT EXISTS embedding_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  block_type TEXT NOT NULL CHECK (block_type IN ('user', 'mua')),
  block_id UUID NOT NULL,
  profile_id TEXT NOT NULL REFERENCES embedding_profiles(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'done', 'error')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(block_type, block_id, profile_id)
);

INSERT INTO embedding_profiles (id, provider, model, dimensions, is_active, metadata)
VALUES ('default-512', 'openai', 'text-embedding-3-small', 512, TRUE, '{}'::jsonb)
ON CONFLICT (id) DO UPDATE
SET provider = EXCLUDED.provider,
    model = EXCLUDED.model,
    dimensions = EXCLUDED.dimensions,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

CREATE INDEX IF NOT EXISTS idx_user_blocks_created_at ON user_blocks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_blocks_visibility ON user_blocks(visibility);
CREATE INDEX IF NOT EXISTS idx_user_blocks_source ON user_blocks(source);

CREATE INDEX IF NOT EXISTS idx_user_block_versions_block_capture ON user_block_versions(block_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_block_versions_hash ON user_block_versions(content_hash);

CREATE INDEX IF NOT EXISTS idx_mua_blocks_created_at ON mua_blocks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mua_blocks_visibility ON mua_blocks(visibility);
CREATE INDEX IF NOT EXISTS idx_mua_blocks_kind ON mua_blocks(block_kind);

CREATE INDEX IF NOT EXISTS idx_entities_type_name ON entities(entity_type, canonical_name);
CREATE INDEX IF NOT EXISTS idx_entities_aliases ON entities USING GIN(aliases);

CREATE INDEX IF NOT EXISTS idx_artifacts_source_status ON artifacts(source_type, ingest_status);
CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_checksum ON artifacts(checksum);

CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_links_type ON links(link_type);

CREATE INDEX IF NOT EXISTS idx_clarification_status ON clarification_queue(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_processing_state_state_updated ON processing_state(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_system_events_component_created ON system_events(component, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_events_level_created ON system_events(level, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_block_embeddings_profile_type_id ON block_embeddings(profile_id, block_type, block_id);
CREATE INDEX IF NOT EXISTS idx_embedding_queue_state_created ON embedding_queue(state, created_at);

CREATE OR REPLACE VIEW all_blocks_v AS
SELECT
  id,
  created_at,
  updated_at,
  content,
  visibility,
  source,
  source_ref,
  metadata,
  'user'::text AS author_type,
  NULL::text AS block_kind,
  NULL::numeric AS confidence
FROM user_blocks
UNION ALL
SELECT
  id,
  created_at,
  updated_at,
  content,
  visibility,
  source,
  source_ref,
  metadata,
  'mua'::text AS author_type,
  block_kind,
  confidence
FROM mua_blocks;

CREATE OR REPLACE FUNCTION search_all_blocks(
  query_embedding VECTOR(512),
  profile_id TEXT DEFAULT NULL,
  include_user BOOLEAN DEFAULT TRUE,
  include_mua BOOLEAN DEFAULT TRUE,
  match_threshold FLOAT DEFAULT 0.70,
  match_count INT DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  author_type TEXT,
  content TEXT,
  visibility TEXT,
  source TEXT,
  block_kind TEXT,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
AS $$
  WITH active_profile AS (
    SELECT COALESCE(
      profile_id,
      (SELECT ep.id FROM embedding_profiles ep WHERE ep.is_active = TRUE ORDER BY ep.updated_at DESC LIMIT 1),
      'default-512'
    ) AS id
  )
  SELECT
    b.id,
    b.author_type,
    b.content,
    b.visibility,
    b.source,
    b.block_kind,
    1 - (e.embedding <=> query_embedding) AS similarity,
    b.created_at
  FROM all_blocks_v b
  JOIN active_profile ap ON TRUE
  JOIN block_embeddings e
    ON e.block_id = b.id
   AND e.block_type = b.author_type
   AND e.profile_id = ap.id
  WHERE ((include_user AND b.author_type = 'user') OR (include_mua AND b.author_type = 'mua'))
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC, b.created_at DESC
  LIMIT match_count;
$$ LANGUAGE sql STABLE;

COMMIT;
