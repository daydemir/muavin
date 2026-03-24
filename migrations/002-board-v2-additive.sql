BEGIN;

ALTER TABLE public.links
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS label_embedding VECTOR(512);

CREATE INDEX IF NOT EXISTS idx_links_label_embedding
  ON public.links USING hnsw (label_embedding vector_cosine_ops);

ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS name TEXT;

UPDATE public.entities
SET name = canonical_name
WHERE name IS NULL
  AND canonical_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entities_name ON public.entities(name);

COMMIT;
