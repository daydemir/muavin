CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  embedding VECTOR(1536),
  extracted_at TIMESTAMPTZ DEFAULT NULL
);
CREATE INDEX idx_messages_chat ON messages(chat_id, created_at DESC);
CREATE INDEX idx_messages_unextracted ON messages(extracted_at) WHERE extracted_at IS NULL;

CREATE TABLE memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  type TEXT NOT NULL CHECK (type IN ('personal_fact', 'preference', 'goal', 'relationship', 'context')),
  content TEXT NOT NULL,
  source TEXT DEFAULT 'memory_md',
  stale BOOLEAN DEFAULT FALSE,
  embedding VECTOR(1536),
  source_chat_id TEXT DEFAULT NULL,
  source_date TIMESTAMPTZ DEFAULT NULL
);
CREATE INDEX idx_memory_type ON memory(type);
CREATE INDEX idx_memory_stale ON memory(stale);

CREATE OR REPLACE FUNCTION search_context(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
)
RETURNS TABLE (content TEXT, source TEXT, similarity FLOAT)
AS $$
  SELECT content, 'message' AS source, 1 - (embedding <=> query_embedding) AS similarity
  FROM messages WHERE embedding IS NOT NULL AND 1 - (embedding <=> query_embedding) > match_threshold
  UNION ALL
  SELECT content, type AS source, 1 - (embedding <=> query_embedding) AS similarity
  FROM memory WHERE embedding IS NOT NULL AND (stale IS NULL OR stale = FALSE) AND 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$$ LANGUAGE sql;

-- search_memory: memory table only
CREATE OR REPLACE FUNCTION search_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
) RETURNS TABLE (content TEXT, source TEXT, similarity FLOAT) AS $$
  SELECT content, type AS source, 1 - (embedding <=> query_embedding) AS similarity
  FROM memory WHERE embedding IS NOT NULL AND (stale IS NULL OR stale = FALSE)
    AND 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC LIMIT match_count;
$$ LANGUAGE sql;

-- search_messages: messages table only
CREATE OR REPLACE FUNCTION search_messages(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
) RETURNS TABLE (content TEXT, source TEXT, similarity FLOAT) AS $$
  SELECT content, 'message' AS source, 1 - (embedding <=> query_embedding) AS similarity
  FROM messages WHERE embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC LIMIT match_count;
$$ LANGUAGE sql;

-- ── Migration for existing databases ──────────────────────────
-- Run these ALTER statements on an existing database:
--
-- ALTER TABLE messages ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ DEFAULT NULL;
-- CREATE INDEX IF NOT EXISTS idx_messages_unextracted ON messages(extracted_at) WHERE extracted_at IS NULL;
-- ALTER TABLE memory ADD COLUMN IF NOT EXISTS source_chat_id TEXT DEFAULT NULL;
-- ALTER TABLE memory ADD COLUMN IF NOT EXISTS source_date TIMESTAMPTZ DEFAULT NULL;
