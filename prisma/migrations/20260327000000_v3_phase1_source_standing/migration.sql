-- v3.0 Phase 1: Add source provenance and standing fields
-- Decision: source, standing, sourceNote
-- Action:   source
-- Entity:   source, standing, sourceNote

ALTER TABLE "Decision"
  ADD COLUMN IF NOT EXISTS "source"      TEXT,
  ADD COLUMN IF NOT EXISTS "standing"    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "sourceNote"  TEXT;

ALTER TABLE "Action"
  ADD COLUMN IF NOT EXISTS "source"      TEXT;

ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "source"      TEXT,
  ADD COLUMN IF NOT EXISTS "standing"    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "sourceNote"  TEXT;
