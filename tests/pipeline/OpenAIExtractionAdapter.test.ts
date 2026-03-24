import { describe, it, expect, vi } from "vitest";
import { OpenAIExtractionAdapter } from "../../src/infrastructure/llm/OpenAIExtractionAdapter";
import type { LLMClientFactory } from "../../src/infrastructure/llm/LLMClientFactory";
import type { Logger } from "../../src/application/ports/Logger";
import type { WindowMessage } from "../../src/infrastructure/buffer/SlidingWindowBuffer";

const logger: Logger = {
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

function makeLLM(content: string): LLMClientFactory {
  return {
    chatCompletion: vi.fn().mockResolvedValue({ content, model: "test-model", usedFallback: false }),
  } as unknown as LLMClientFactory;
}

const ctx = { channelId: "ch1", purpose: "Engineering team" };
const currentMsg: WindowMessage = {
  messageId: "msg-1",
  authorId: "user-1",
  text: "We decided to use Postgres. Alice will set it up by Friday.",
  timestamp: new Date("2026-03-20T10:00:00Z"),
};
const window: WindowMessage[] = [currentMsg];

describe("OpenAIExtractionAdapter", () => {
  it("extracts decisions, actions, entities, and signals", async () => {
    const llm = makeLLM(JSON.stringify({
      decisions: [{ summary: "Use Postgres for persistence", rationale: "Better for relational data", decided_by: ["Alice", "Bob"], confidence: 0.9, tags: ["infrastructure"] }],
      actions: [{ description: "Set up Postgres database", owner_name: "Alice", deadline: "Friday", confidence: 0.85, tags: ["infrastructure"] }],
      entities: [{ name: "Postgres", entity_type: "service", aliases: ["PostgreSQL"], metadata: {} }],
      relationships: [],
      signals: [{ signal_type: "update", summary: "Team chose Postgres for persistence layer", tags: ["infrastructure"], confidence: 0.8 }],
    }));
    const adapter = new OpenAIExtractionAdapter(llm, logger);
    const result = await adapter.extract(currentMsg, window, ctx, []);

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].summary).toBe("Use Postgres for persistence");
    expect(result.decisions[0].decidedBy).toEqual(["Alice", "Bob"]);
    expect(result.decisions[0].confidence).toBe(0.9);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].description).toBe("Set up Postgres database");
    expect(result.actions[0].ownerName).toBe("Alice");
    expect(result.actions[0].deadline).toBe("Friday");

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe("Postgres");
    expect(result.entities[0].entityType).toBe("service");
    expect(result.entities[0].aliases).toContain("PostgreSQL");

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].signalType).toBe("update");
  });

  it("returns empty result on LLM error", async () => {
    const llm = {
      chatCompletion: vi.fn().mockRejectedValue(new Error("timeout")),
    } as unknown as LLMClientFactory;
    const adapter = new OpenAIExtractionAdapter(llm, logger);
    const result = await adapter.extract(currentMsg, window, ctx, []);
    expect(result.decisions).toHaveLength(0);
    expect(result.actions).toHaveLength(0);
    expect(result.entities).toHaveLength(0);
    expect(result.signals).toHaveLength(0);
  });

  it("returns empty result on malformed JSON", async () => {
    const llm = makeLLM("not valid json");
    const adapter = new OpenAIExtractionAdapter(llm, logger);
    const result = await adapter.extract(currentMsg, window, ctx, []);
    expect(result.decisions).toHaveLength(0);
  });

  it("filters decisions missing summary", async () => {
    const llm = makeLLM(JSON.stringify({
      decisions: [{ summary: "", confidence: 0.9, tags: [] }],
      actions: [], entities: [], relationships: [], signals: [],
    }));
    const adapter = new OpenAIExtractionAdapter(llm, logger);
    const result = await adapter.extract(currentMsg, window, ctx, []);
    expect(result.decisions).toHaveLength(0);
  });

  it("uses 'concept' as fallback for unknown entity type", async () => {
    const llm = makeLLM(JSON.stringify({
      decisions: [], actions: [],
      entities: [{ name: "Acme Corp", entity_type: "corporation", aliases: [] }],
      relationships: [], signals: [],
    }));
    const adapter = new OpenAIExtractionAdapter(llm, logger);
    const result = await adapter.extract(currentMsg, window, ctx, []);
    expect(result.entities[0].entityType).toBe("concept");
  });

  it("uses 'works_on' as fallback for unknown relationship type", async () => {
    const llm = makeLLM(JSON.stringify({
      decisions: [], actions: [], entities: [],
      relationships: [{ source_name: "Alice", target_name: "Postgres", relationship: "uses", context: "uses it" }],
      signals: [],
    }));
    const adapter = new OpenAIExtractionAdapter(llm, logger);
    const result = await adapter.extract(currentMsg, window, ctx, []);
    expect(result.relationships[0].relationship).toBe("works_on");
  });

  it("strips ```json markdown from response", async () => {
    const llm = makeLLM(
      "```json\n" + JSON.stringify({ decisions: [], actions: [], entities: [], relationships: [], signals: [] }) + "\n```"
    );
    const adapter = new OpenAIExtractionAdapter(llm, logger);
    const result = await adapter.extract(currentMsg, window, ctx, []);
    expect(result.decisions).toHaveLength(0);
  });
});
