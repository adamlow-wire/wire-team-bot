-- Phase 1b: Schema drops
-- Migrate Task records → Action, then drop Task/KnowledgeEntry/ConversationConfig tables.
-- Drop rawMessage columns from surviving tables.
-- Add HNSW index on embeddings.embedding for ANN search.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Migrate Task → Action (best-effort, preserving IDs)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "Action" (
  id, "conversationId", "conversationDom",
  "creatorId", "creatorDom", "authorName",
  "assigneeId", "assigneeDom", "assigneeName",
  "rawMessageId", "rawMessage",
  description, deadline, status,
  "linkedIds", "reminderAt",
  "completionNote", tags,
  timestamp, "updatedAt", deleted, version
)
SELECT
  id,
  "conversationId", "conversationDom",
  "authorId", "authorDom", "authorName",
  "assigneeId", "assigneeDom", "assigneeName",
  COALESCE("rawMessageId", ''), '',
  description, deadline,
  CASE status WHEN 'done' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'open' END,
  "linkedIds", '[]'::json,
  "completionNote", tags,
  timestamp, "updatedAt", deleted, version
FROM "Task"
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Drop retired tables
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "Task";
DROP TABLE IF EXISTS "KnowledgeEntry";
DROP TABLE IF EXISTS "ConversationConfig";

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Drop rawMessage columns from surviving tables
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "Decision" DROP COLUMN IF EXISTS "rawMessage";
ALTER TABLE "Action"   DROP COLUMN IF EXISTS "rawMessage";
ALTER TABLE "Reminder" DROP COLUMN IF EXISTS "rawMessage";

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Add embedding vector column + HNSW index (requires pgvector)
--    Uses DO block so it is idempotent: safe to re-run if column already exists.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'embeddings' AND column_name = 'embedding'
  ) THEN
    ALTER TABLE embeddings ADD COLUMN embedding vector(1024);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_idx
  ON embeddings
  USING hnsw (embedding vector_cosine_ops);
