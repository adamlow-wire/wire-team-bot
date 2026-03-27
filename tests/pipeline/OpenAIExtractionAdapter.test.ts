import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIExtractionAdapter } from "../../src/infrastructure/llm/OpenAIExtractionAdapter";
import type { VercelAISlotFactory } from "../../src/infrastructure/llm/VercelAISlotFactory";
import type { Logger } from "../../src/application/ports/Logger";
import type { WindowMessage } from "../../src/infrastructure/buffer/SlidingWindowBuffer";

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

const ctx = { channelId: "ch1", purpose: "Engineering team" };
const currentMsg: WindowMessage = {
  messageId: "msg-1",
  authorId: "user-1",
  text: "We decided to use Postgres. Alice will set it up by Friday.",
  timestamp: new Date("2026-03-20T10:00:00Z"),
};
const window: WindowMessage[] = [currentMsg];
const USAGE = { inputTokens: 200, outputTokens: 100 };

describe("OpenAIExtractionAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts decisions, actions, entities, and signals", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        decisions: [{ summary: "Use Postgres for persistence", rationale: "Better for relational data", decided_by: ["Alice", "Bob"], confidence: 0.9, tags: ["infrastructure"] }],
        actions: [{ description: "Set up Postgres database", owner_name: "Alice", deadline_text: "Friday", confidence: 0.85, tags: ["infrastructure"] }],
        completions: [],
        entities: [{ name: "Postgres", type: "service", aliases: ["PostgreSQL"], confidence: 0.9 }],
        relationships: [],
        signals: [{ signal_type: "update", summary: "Team chose Postgres for persistence layer", tags: ["infrastructure"], confidence: 0.8 }],
      },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIExtractionAdapter(makeLLM(), logger);
    const result = await adapter.extract(currentMsg, window, ctx, [], []);

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.summary).toBe("Use Postgres for persistence");
    expect(result.decisions[0]!.decidedBy).toEqual(["Alice", "Bob"]);
    expect(result.decisions[0]!.confidence).toBe(0.9);

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.description).toBe("Set up Postgres database");
    expect(result.actions[0]!.ownerName).toBe("Alice");
    expect(result.actions[0]!.deadline).toBe("Friday");

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.name).toBe("Postgres");
    expect(result.entities[0]!.entityType).toBe("service");
    expect(result.entities[0]!.aliases).toContain("PostgreSQL");

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.signalType).toBe("update");
  });

  it("returns empty result on LLM error", async () => {
    mockGenerateObject.mockRejectedValue(new Error("timeout"));
    const adapter = new OpenAIExtractionAdapter(makeLLM(), logger);
    const result = await adapter.extract(currentMsg, window, ctx, [], []);
    expect(result.decisions).toHaveLength(0);
    expect(result.actions).toHaveLength(0);
    expect(result.entities).toHaveLength(0);
    expect(result.signals).toHaveLength(0);
  });

  it("returns empty result on schema error", async () => {
    mockGenerateObject.mockRejectedValue(new Error("schema validation failed"));
    const adapter = new OpenAIExtractionAdapter(makeLLM(), logger);
    const result = await adapter.extract(currentMsg, window, ctx, [], []);
    expect(result.decisions).toHaveLength(0);
  });

  it("filters decisions missing summary via Zod min(1)", async () => {
    // Zod will reject empty summary and cause generateObject to throw
    mockGenerateObject.mockRejectedValue(new Error("NoObjectGeneratedError"));
    const adapter = new OpenAIExtractionAdapter(makeLLM(), logger);
    const result = await adapter.extract(currentMsg, window, ctx, [], []);
    expect(result.decisions).toHaveLength(0);
  });

  it("maps entity type from schema field 'type' to port field 'entityType'", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        decisions: [], actions: [], completions: [],
        entities: [{ name: "Acme Corp", type: "concept", aliases: [], confidence: 0.7 }],
        relationships: [], signals: [],
      },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIExtractionAdapter(makeLLM(), logger);
    const result = await adapter.extract(currentMsg, window, ctx, [], []);
    expect(result.entities[0]!.entityType).toBe("concept");
  });

  it("maps relationship fields from schema to port interface", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        decisions: [], actions: [], completions: [], entities: [],
        relationships: [{ source: "Alice", target: "Postgres", relationship: "works_on", context: "sets it up", confidence: 0.8 }],
        signals: [],
      },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIExtractionAdapter(makeLLM(), logger);
    const result = await adapter.extract(currentMsg, window, ctx, [], []);
    expect(result.relationships[0]!.sourceName).toBe("Alice");
    expect(result.relationships[0]!.targetName).toBe("Postgres");
    expect(result.relationships[0]!.relationship).toBe("works_on");
  });

  it("returns empty on successful schema-valid empty response", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { decisions: [], actions: [], completions: [], entities: [], relationships: [], signals: [] },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIExtractionAdapter(makeLLM(), logger);
    const result = await adapter.extract(currentMsg, window, ctx, [], []);
    expect(result.decisions).toHaveLength(0);
  });
});
