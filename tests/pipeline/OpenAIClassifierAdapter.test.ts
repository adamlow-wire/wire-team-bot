import { describe, it, expect, vi } from "vitest";
import { OpenAIClassifierAdapter } from "../../src/infrastructure/llm/OpenAIClassifierAdapter";
import type { LLMClientFactory } from "../../src/infrastructure/llm/LLMClientFactory";
import type { Logger } from "../../src/application/ports/Logger";

const logger: Logger = {
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

function makeLLM(content: string): LLMClientFactory {
  return {
    chatCompletion: vi.fn().mockResolvedValue({ content, model: "test-model", usedFallback: false }),
  } as unknown as LLMClientFactory;
}

const ctx = { channelId: "ch1" };

describe("OpenAIClassifierAdapter", () => {
  it("parses a high-signal decision result", async () => {
    const llm = makeLLM(JSON.stringify({
      categories: ["decision"],
      confidence: 0.9,
      entities: ["Postgres"],
      is_high_signal: true,
    }));
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("We decided to use Postgres", ctx, []);
    expect(result.categories).toContain("decision");
    expect(result.is_high_signal).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.entities).toContain("Postgres");
  });

  it("parses a low-signal discussion result", async () => {
    const llm = makeLLM(JSON.stringify({
      categories: ["discussion"],
      confidence: 0.7,
      entities: [],
      is_high_signal: false,
    }));
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("Sounds good to me", ctx, []);
    expect(result.is_high_signal).toBe(false);
    expect(result.categories).toContain("discussion");
  });

  it("infers is_high_signal from categories when LLM omits it", async () => {
    const llm = makeLLM(JSON.stringify({
      categories: ["action", "update"],
      confidence: 0.85,
      entities: ["Alice"],
    }));
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("Alice will review the PR by Friday", ctx, []);
    expect(result.is_high_signal).toBe(true);
  });

  it("falls back on LLM error", async () => {
    const llm = {
      chatCompletion: vi.fn().mockRejectedValue(new Error("timeout")),
    } as unknown as LLMClientFactory;
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("some text", ctx, []);
    expect(result.categories).toContain("discussion");
    expect(result.is_high_signal).toBe(false);
  });

  it("falls back on malformed JSON", async () => {
    const llm = makeLLM("not json at all");
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("some text", ctx, []);
    expect(result.categories).toContain("discussion");
    expect(result.is_high_signal).toBe(false);
  });

  it("filters invalid category values", async () => {
    const llm = makeLLM(JSON.stringify({
      categories: ["decision", "INVALID_CAT", "action"],
      confidence: 0.8,
      entities: [],
      is_high_signal: true,
    }));
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("We decided and Alice will act", ctx, []);
    expect(result.categories).toEqual(["decision", "action"]);
  });

  it("strips ```json markdown wrappers", async () => {
    const llm = makeLLM(
      "```json\n" + JSON.stringify({ categories: ["blocker"], confidence: 0.8, entities: [], is_high_signal: true }) + "\n```"
    );
    const adapter = new OpenAIClassifierAdapter(llm, logger);
    const result = await adapter.classify("build is broken", ctx, []);
    expect(result.categories).toContain("blocker");
    expect(result.is_high_signal).toBe(true);
  });
});
