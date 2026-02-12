BEGIN;

-- NULL out existing embeddings (384-dim, incompatible with 512)
UPDATE messages SET embedding = NULL WHERE embedding IS NOT NULL;
UPDATE memory SET embedding = NULL WHERE embedding IS NOT NULL;

-- Alter column types
ALTER TABLE messages ALTER COLUMN embedding TYPE VECTOR(512);
ALTER TABLE memory ALTER COLUMN embedding TYPE VECTOR(512);

-- Recreate RPC functions with VECTOR(512) parameter types
CREATE OR REPLACE FUNCTION search_context(
  query_embedding VECTOR(512),
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

CREATE OR REPLACE FUNCTION search_memory(
  query_embedding VECTOR(512),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
) RETURNS TABLE (content TEXT, source TEXT, similarity FLOAT) AS $$
  SELECT content, type AS source, 1 - (embedding <=> query_embedding) AS similarity
  FROM memory WHERE embedding IS NOT NULL AND (stale IS NULL OR stale = FALSE)
    AND 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC LIMIT match_count;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION search_messages(
  query_embedding VECTOR(512),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
) RETURNS TABLE (content TEXT, source TEXT, similarity FLOAT) AS $$
  SELECT content, 'message' AS source, 1 - (embedding <=> query_embedding) AS similarity
  FROM messages WHERE embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC LIMIT match_count;
$$ LANGUAGE sql;

COMMIT;
