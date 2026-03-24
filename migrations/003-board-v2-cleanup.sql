BEGIN;

UPDATE public.links
SET link_type = CASE link_type
  WHEN 'references' THEN 'related'
  WHEN 'mentions' THEN 'about'
  WHEN 'supersedes' THEN 'related'
  WHEN 'candidate_match' THEN 'related'
  ELSE link_type
END
WHERE link_type IN ('references', 'mentions', 'supersedes', 'candidate_match');

ALTER TABLE public.links
  DROP CONSTRAINT IF EXISTS links_link_type_check;

ALTER TABLE public.links
  ADD CONSTRAINT links_link_type_check
  CHECK (link_type IN ('about', 'derived_from', 'related'));

ALTER TABLE public.links
  DROP COLUMN IF EXISTS confidence;

DROP INDEX IF EXISTS public.idx_entities_type_name;

ALTER TABLE public.entities
  ALTER COLUMN name SET NOT NULL;

ALTER TABLE public.entities
  DROP CONSTRAINT IF EXISTS entities_entity_type_check;

ALTER TABLE public.entities
  DROP COLUMN IF EXISTS canonical_name,
  DROP COLUMN IF EXISTS entity_type,
  DROP COLUMN IF EXISTS verified,
  DROP COLUMN IF EXISTS confidence,
  DROP COLUMN IF EXISTS metadata;

ALTER TABLE public.mua_blocks
  DROP COLUMN IF EXISTS confidence;

CREATE OR REPLACE VIEW public.all_blocks_v AS
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
  NULL::text AS block_kind
FROM public.user_blocks
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
  block_kind
FROM public.mua_blocks;

ALTER VIEW public.all_blocks_v SET (security_invoker = true);

COMMIT;
