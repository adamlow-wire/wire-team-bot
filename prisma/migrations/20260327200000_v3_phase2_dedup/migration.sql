-- v3.0 Phase 2: deduplication fields and partial unique indexes

ALTER TABLE "Decision"
  ADD COLUMN IF NOT EXISTS "contentHash"  TEXT,
  ADD COLUMN IF NOT EXISTS "dismissedAt"  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "mergedIntoId" TEXT;

ALTER TABLE "Action"
  ADD COLUMN IF NOT EXISTS "contentHash"  TEXT,
  ADD COLUMN IF NOT EXISTS "dismissedAt"  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "mergedIntoId" TEXT;

-- Partial unique indexes — WHERE clause not expressible in Prisma @unique.
-- Multiple NULLs are permitted (NULLs are not considered equal in Postgres UNIQUE).
-- The WHERE clause makes this explicit and exempts seed/legacy rows without a hash.
CREATE UNIQUE INDEX IF NOT EXISTS "Decision_channel_content_hash_key"
  ON "Decision" ("conversationId", "contentHash")
  WHERE "contentHash" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Action_channel_content_hash_key"
  ON "Action" ("conversationId", "contentHash")
  WHERE "contentHash" IS NOT NULL;
