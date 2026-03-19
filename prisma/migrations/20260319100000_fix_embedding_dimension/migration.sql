-- Fix embedding column dimension: 1536 → 1024 to match bge-m3:567m.
-- No data is lost because no embeddings were successfully stored with the
-- previous dimension (the backfill failed due to the missing model alias).

DROP INDEX IF EXISTS "KnowledgeEntry_embedding_hnsw_idx";

ALTER TABLE "KnowledgeEntry"
  ALTER COLUMN embedding TYPE vector(1024)
  USING NULL;

CREATE INDEX IF NOT EXISTS "KnowledgeEntry_embedding_hnsw_idx"
  ON "KnowledgeEntry" USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
