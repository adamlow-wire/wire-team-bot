-- Phase 1a: Schema additions (additive only — no drops, no data loss)
-- All new columns are nullable or have defaults so existing rows are unaffected.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add organisation_id to existing tables; backfill from conversationDom
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Task"           ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "Reminder"       ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "Decision"       ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "Action"         ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "KnowledgeEntry" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "AuditLog"       ADD COLUMN IF NOT EXISTS "organisationId" TEXT;

UPDATE "Task"           SET "organisationId" = "conversationDom" WHERE "organisationId" IS NULL;
UPDATE "Reminder"       SET "organisationId" = "conversationDom" WHERE "organisationId" IS NULL;
UPDATE "Decision"       SET "organisationId" = "conversationDom" WHERE "organisationId" IS NULL;
UPDATE "Action"         SET "organisationId" = "conversationDom" WHERE "organisationId" IS NULL;
UPDATE "KnowledgeEntry" SET "organisationId" = "conversationDom" WHERE "organisationId" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add source_ref JSONB; backfill from rawMessageId where present
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Task"     ADD COLUMN IF NOT EXISTS "sourceRef" JSONB;
ALTER TABLE "Reminder" ADD COLUMN IF NOT EXISTS "sourceRef" JSONB;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "sourceRef" JSONB;
ALTER TABLE "Action"   ADD COLUMN IF NOT EXISTS "sourceRef" JSONB;

UPDATE "Task" SET "sourceRef" = jsonb_build_object(
  'wire_msg_ids', jsonb_build_array("rawMessageId"),
  'timestamp_range', jsonb_build_object('start', to_char("timestamp", 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'end', to_char("timestamp", 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
) WHERE "sourceRef" IS NULL AND "rawMessageId" IS NOT NULL AND "rawMessageId" != '';

UPDATE "Reminder" SET "sourceRef" = jsonb_build_object(
  'wire_msg_ids', jsonb_build_array("rawMessageId"),
  'timestamp_range', jsonb_build_object('start', to_char("timestamp", 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'end', to_char("timestamp", 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
) WHERE "sourceRef" IS NULL AND "rawMessageId" IS NOT NULL AND "rawMessageId" != '';

UPDATE "Decision" SET "sourceRef" = jsonb_build_object(
  'wire_msg_ids', jsonb_build_array("rawMessageId"),
  'timestamp_range', jsonb_build_object('start', to_char("timestamp", 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'end', to_char("timestamp", 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
) WHERE "sourceRef" IS NULL AND "rawMessageId" IS NOT NULL AND "rawMessageId" != '';

UPDATE "Action" SET "sourceRef" = jsonb_build_object(
  'wire_msg_ids', jsonb_build_array("rawMessageId"),
  'timestamp_range', jsonb_build_object('start', to_char("timestamp", 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'end', to_char("timestamp", 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
) WHERE "sourceRef" IS NULL AND "rawMessageId" IS NOT NULL AND "rawMessageId" != '';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Add decided_at to Decision; backfill from timestamp
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "decidedAt"       TIMESTAMPTZ;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "rationale"       TEXT;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "decidedBy"       TEXT[] DEFAULT '{}';
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "confidence"      REAL;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "extractionModel" TEXT;

UPDATE "Decision" SET "decidedAt" = "timestamp" WHERE "decidedAt" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Add staleness/confidence fields to Action
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Action" ADD COLUMN IF NOT EXISTS "stalenessAt"       TIMESTAMPTZ;
ALTER TABLE "Action" ADD COLUMN IF NOT EXISTS "lastStatusCheck"   TIMESTAMPTZ;
ALTER TABLE "Action" ADD COLUMN IF NOT EXISTS "actionConfidence"  REAL;
ALTER TABLE "Action" ADD COLUMN IF NOT EXISTS "relatedDecisionId" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Create channel_config (replaces ConversationConfig in Phase 1b)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS channel_config (
  channel_id          TEXT PRIMARY KEY,
  channel_name        TEXT,
  organisation_id     TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'active',
  state_changed_at    TIMESTAMPTZ,
  state_changed_by    TEXT,
  purpose             TEXT,
  context_type        TEXT,
  tags                TEXT[]   DEFAULT '{}',
  stakeholders        TEXT[]   DEFAULT '{}',
  related_channels    TEXT[]   DEFAULT '{}',
  context_updated_at  TIMESTAMPTZ,
  context_updated_by  TEXT,
  secure_ranges       JSONB    DEFAULT '[]',
  timezone            TEXT     NOT NULL DEFAULT 'UTC',
  locale              TEXT     NOT NULL DEFAULT 'en',
  joined_at           TIMESTAMPTZ,
  is_personal_mode    BOOLEAN  NOT NULL DEFAULT FALSE
);

-- Migrate existing ConversationConfig rows into channel_config
INSERT INTO channel_config (
  channel_id,
  organisation_id,
  state,
  purpose,
  secure_ranges,
  timezone,
  locale
)
SELECT
  "conversationId" || '@' || "conversationDom"  AS channel_id,
  "conversationDom"                             AS organisation_id,
  CASE WHEN "secretMode" THEN 'secure' ELSE 'active' END AS state,
  ("raw"->>'purpose'),
  '[]'::JSONB,
  COALESCE("timezone", 'UTC'),
  COALESCE("locale", 'en')
FROM "ConversationConfig"
ON CONFLICT (channel_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Create entities
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS entities (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      TEXT        NOT NULL,
  organisation_id TEXT        NOT NULL,
  entity_type     TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  aliases         TEXT[]      DEFAULT '{}',
  metadata        JSONB       DEFAULT '{}',
  first_seen      TIMESTAMPTZ,
  last_mentioned  TIMESTAMPTZ,
  mention_count   INTEGER     NOT NULL DEFAULT 1,
  deleted         BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS entities_type_name     ON entities (entity_type, name);
CREATE INDEX IF NOT EXISTS entities_org_type      ON entities (organisation_id, entity_type);
CREATE INDEX IF NOT EXISTS entities_aliases_gin   ON entities USING GIN (aliases);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Create entity_relationships
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS entity_relationships (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id        UUID        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id        UUID        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship     TEXT        NOT NULL,
  context          TEXT,
  confidence       REAL        NOT NULL DEFAULT 0.7,
  first_observed   TIMESTAMPTZ,
  last_observed    TIMESTAMPTZ,
  observation_count INTEGER    NOT NULL DEFAULT 1,
  source_ref       JSONB,

  CONSTRAINT entity_relationships_unique UNIQUE (source_id, target_id, relationship)
);

CREATE INDEX IF NOT EXISTS entity_rel_source ON entity_relationships (source_id, relationship);
CREATE INDEX IF NOT EXISTS entity_rel_target ON entity_relationships (target_id, relationship);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Create embeddings (vector column added separately after pgvector extension confirmed)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS embeddings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type     TEXT        NOT NULL,
  source_id       UUID,
  channel_id      TEXT        NOT NULL,
  organisation_id TEXT        NOT NULL,
  author_id       TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  topic_tags      TEXT[]      DEFAULT '{}'
);

-- The embedding vector column is added after confirming qwen3-embedding:4b dims.
-- Run separately: ALTER TABLE embeddings ADD COLUMN embedding vector(1024);
-- Then: CREATE INDEX ON embeddings USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS embeddings_channel_created ON embeddings (channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS embeddings_source          ON embeddings (source_type, source_id);
CREATE INDEX IF NOT EXISTS embeddings_tags_gin        ON embeddings USING GIN (topic_tags);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Create conversation_signals
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_signals (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      TEXT        NOT NULL,
  organisation_id TEXT        NOT NULL,
  signal_type     TEXT        NOT NULL,
  summary         TEXT        NOT NULL,
  participants    TEXT[]      DEFAULT '{}',
  tags            TEXT[]      DEFAULT '{}',
  related_entities TEXT[]     DEFAULT '{}',
  occurred_at     TIMESTAMPTZ NOT NULL,
  confidence      REAL        NOT NULL DEFAULT 0.6,
  source_ref      JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signals_channel_occurred ON conversation_signals (channel_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS signals_type_occurred    ON conversation_signals (signal_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS signals_tags_gin         ON conversation_signals USING GIN (tags);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Create conversation_summaries
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type      TEXT        NOT NULL,
  scope_id        TEXT        NOT NULL,
  organisation_id TEXT        NOT NULL,
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  granularity     TEXT        NOT NULL,
  summary         TEXT        NOT NULL,
  key_decisions   TEXT[]      DEFAULT '{}',
  key_actions     TEXT[]      DEFAULT '{}',
  active_topics   TEXT[]      DEFAULT '{}',
  participants    TEXT[]      DEFAULT '{}',
  sentiment       TEXT,
  message_count   INTEGER,
  model_version   TEXT,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT summaries_unique UNIQUE (scope_type, scope_id, granularity, period_start)
);
