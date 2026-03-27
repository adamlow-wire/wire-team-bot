import { describe, it, expect } from "vitest";
import { normaliseText, computeContentHash } from "../../src/infrastructure/pipeline/contentHash";

describe("normaliseText", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normaliseText("  Hello   World  ")).toBe("hello world");
    expect(normaliseText("  UPPER CASE  ")).toBe("upper case");
    expect(normaliseText("already normal")).toBe("already normal");
  });

  it("handles empty string", () => {
    expect(normaliseText("")).toBe("");
  });
});

describe("computeContentHash", () => {
  it("produces the same hash for equivalent text variants", () => {
    const h1 = computeContentHash("We decided to use Postgres");
    const h2 = computeContentHash("  We decided to use Postgres  ");
    const h3 = computeContentHash("WE DECIDED TO USE POSTGRES");
    const h4 = computeContentHash("We  decided  to  use  Postgres");
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
    expect(h1).toBe(h4);
  });

  it("produces different hashes for different content", () => {
    const h1 = computeContentHash("Use Postgres");
    const h2 = computeContentHash("Use MySQL");
    expect(h1).not.toBe(h2);
  });

  it("returns a 64-character hex string (SHA-256)", () => {
    const h = computeContentHash("test");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic across calls", () => {
    const text = "Deploy to production on Friday";
    expect(computeContentHash(text)).toBe(computeContentHash(text));
  });

  it("handles empty string without throwing", () => {
    expect(() => computeContentHash("")).not.toThrow();
    expect(computeContentHash("")).toHaveLength(64);
  });
});
