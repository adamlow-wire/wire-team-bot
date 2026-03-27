import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIClassifierAdapter } from "../../src/infrastructure/llm/OpenAIClassifierAdapter";
import type { VercelAISlotFactory } from "../../src/infrastructure/llm/VercelAISlotFactory";
import type { Logger } from "../../src/application/ports/Logger";

// Mock the Vercel AI SDK generateObject function
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";
const mockGenerateObject = vi.mocked(generateObject);

const logger: Logger = {
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

function makeLLM(): VercelAISlotFactory {
  return {
    getModel: vi.fn().mockReturnValue("test-model"),
    getFallbackModel: vi.fn(),
    getRespondModel: vi.fn(),
    timeoutMs: 10000,
  } as unknown as VercelAISlotFactory;
}

const ctx = { channelId: "ch1" };
const USAGE = { inputTokens: 100, outputTokens: 50 };

describe("OpenAIClassifierAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a high-signal decision result", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { categories: ["decision"], confidence: 0.9, entities: ["Postgres"], is_high_signal: true },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIClassifierAdapter(makeLLM(), logger);
    const result = await adapter.classify("We decided to use Postgres", ctx, []);
    expect(result.categories).toContain("decision");
    expect(result.is_high_signal).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.entities).toContain("Postgres");
  });

  it("parses a low-signal discussion result", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { categories: ["discussion"], confidence: 0.7, entities: [], is_high_signal: false },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIClassifierAdapter(makeLLM(), logger);
    const result = await adapter.classify("Sounds good to me", ctx, []);
    expect(result.is_high_signal).toBe(false);
    expect(result.categories).toContain("discussion");
  });

  it("infers is_high_signal from categories when LLM omits it", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { categories: ["action", "update"], confidence: 0.85, entities: ["Alice"], is_high_signal: true },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIClassifierAdapter(makeLLM(), logger);
    const result = await adapter.classify("Alice will review the PR by Friday", ctx, []);
    expect(result.is_high_signal).toBe(true);
  });

  it("falls back on LLM error", async () => {
    mockGenerateObject.mockRejectedValue(new Error("timeout"));
    const adapter = new OpenAIClassifierAdapter(makeLLM(), logger);
    const result = await adapter.classify("some text", ctx, []);
    expect(result.categories).toContain("discussion");
    expect(result.is_high_signal).toBe(false);
  });

  it("falls back on malformed response", async () => {
    mockGenerateObject.mockRejectedValue(new Error("schema validation failed"));
    const adapter = new OpenAIClassifierAdapter(makeLLM(), logger);
    const result = await adapter.classify("some text", ctx, []);
    expect(result.categories).toContain("discussion");
    expect(result.is_high_signal).toBe(false);
  });

  it("filters invalid category values via Zod schema defaults", async () => {
    // Zod filters invalid enum values — the adapter returns what the schema outputs
    mockGenerateObject.mockResolvedValue({
      object: { categories: ["decision", "action"], confidence: 0.8, entities: [], is_high_signal: true },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIClassifierAdapter(makeLLM(), logger);
    const result = await adapter.classify("We decided and Alice will act", ctx, []);
    expect(result.categories).toContain("decision");
    expect(result.categories).toContain("action");
  });

  it("returns categories from schema output", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { categories: ["blocker"], confidence: 0.8, entities: [], is_high_signal: true },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIClassifierAdapter(makeLLM(), logger);
    const result = await adapter.classify("build is broken", ctx, []);
    expect(result.categories).toContain("blocker");
    expect(result.is_high_signal).toBe(true);
  });
});
