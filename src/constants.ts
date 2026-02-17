// 512 dims: best quality/performance balance for text-embedding-3-small at this scale
// Model supports 256-1536; 512 is near-identical quality at 1/3 storage
export const EMBEDDING_DIMS = 512;
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_TIMEOUT_MS = 20_000;
