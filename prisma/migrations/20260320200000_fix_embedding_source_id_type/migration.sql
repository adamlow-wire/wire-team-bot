-- Fix: embeddings.source_id was incorrectly typed as UUID.
-- Source IDs are sequence-based text identifiers (e.g. "ACT-0001", "DEC-0001"),
-- not UUIDs. Change to TEXT.
ALTER TABLE embeddings ALTER COLUMN source_id TYPE TEXT USING source_id::text;
