-- Fix embedding column dimension: 1024 → 2560 to match qwen3-embedding:4b actual output.
-- No data loss: all prior inserts failed due to dimension mismatch, so the table is empty.
-- Note: pgvector HNSW supports max 2000 dims; 2560 uses exact cosine search (fine at team scale).

DROP INDEX IF EXISTS embeddings_embedding_hnsw_idx;

ALTER TABLE embeddings
  ALTER COLUMN embedding TYPE vector(2560)
  USING NULL;
