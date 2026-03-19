-- Phase 2: Knowledge embedding for hybrid semantic + keyword search
--
-- Requires the pgvector extension. Run:
--   CREATE EXTENSION IF NOT EXISTS vector;
-- on your PostgreSQL instance before applying this migration if it is not
-- already installed (requires the pgvector package on the server).
--
-- Dimension default: 1536 (text-embedding-3-small / OpenAI ada-002).
-- If using a different model, change the dimension here AND set LLM_EMBEDDING_DIMS
-- in your environment to the same value before running BackfillEmbeddings.

CREATE EXTENSION IF NOT EXISTS vector;

-- Nullable: existing entries have no embedding until the backfill job runs.
ALTER TABLE "KnowledgeEntry" ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW index: works at any table size without requiring a training step.
-- ef_construction=64 and m=16 are good defaults for a team-scale KB.
CREATE INDEX IF NOT EXISTS "KnowledgeEntry_embedding_hnsw_idx"
  ON "KnowledgeEntry" USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
