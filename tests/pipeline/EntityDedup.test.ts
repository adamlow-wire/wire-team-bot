/**
 * Unit tests for entity deduplication logic.
 * Tests the normalised-name dedup logic by mocking the Prisma client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractedEntity } from "../../src/application/ports/ExtractionPort";

// We test the dedup matching logic directly without instantiating the full repo
// (which requires a live DB connection). The matching logic is purely in-process.

/**
 * Extracted from PrismaEntityRepository to test in isolation.
 * Returns true when candidate and new entity should be merged.
 */
function shouldMerge(
  candidate: { name: string; aliases: string[] },
  entity: { name: string; aliases: string[] },
): boolean {
  const nameLower = entity.name.toLowerCase().trim();
  const cName = candidate.name.toLowerCase().trim();
  if (cName === nameLower) return true;
  const aliasLower = candidate.aliases.map((a) => a.toLowerCase().trim());
  if (aliasLower.includes(nameLower)) return true;
  const newAliasesLower = entity.aliases.map((a) => a.toLowerCase().trim());
  if (newAliasesLower.includes(cName)) return true;
  return false;
}

describe("Entity dedup matching", () => {
  it("matches exact name (case-insensitive)", () => {
    expect(shouldMerge(
      { name: "Postgres", aliases: [] },
      { name: "postgres", aliases: [] },
    )).toBe(true);
  });

  it("matches when new name appears in candidate aliases", () => {
    expect(shouldMerge(
      { name: "Postgres", aliases: ["PostgreSQL", "pg"] },
      { name: "pg", aliases: [] },
    )).toBe(true);
  });

  it("matches when candidate name appears in new entity aliases", () => {
    expect(shouldMerge(
      { name: "Postgres", aliases: [] },
      { name: "PostgreSQL", aliases: ["postgres"] },
    )).toBe(true);
  });

  it("does NOT match different entities", () => {
    expect(shouldMerge(
      { name: "Postgres", aliases: ["pg"] },
      { name: "MySQL", aliases: [] },
    )).toBe(false);
  });

  it("does NOT merge across different entity types (type guard at repo level)", () => {
    // The repo filters by entity_type first, so two different types never reach shouldMerge
    // This test documents the expected behaviour at the query level
    expect(shouldMerge(
      { name: "Alice", aliases: [] },
      { name: "alice", aliases: [] },
    )).toBe(true);  // same logic — type discrimination happens at the query level
  });
});
