-- Atomic per-entity-type ID counter replacing the racy count()+1 approach.
-- Uses INSERT … ON CONFLICT DO UPDATE so concurrent writers each get a unique value.
CREATE TABLE entity_id_sequences (
  entity_type VARCHAR(50) NOT NULL PRIMARY KEY,
  next_val    INTEGER NOT NULL DEFAULT 1
);
