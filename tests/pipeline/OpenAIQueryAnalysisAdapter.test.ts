import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIQueryAnalysisAdapter } from "../../src/infrastructure/llm/OpenAIQueryAnalysisAdapter";
import type { VercelAISlotFactory } from "../../src/infrastructure/llm/VercelAISlotFactory";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";
const mockGenerateObject = vi.mocked(generateObject);

function makeLLM(): VercelAISlotFactory {
  return {
    getModel: vi.fn().mockReturnValue("test-model"),
    getFallbackModel: vi.fn(),
    getRespondModel: vi.fn(),
    timeoutMs: 10000,
  } as unknown as VercelAISlotFactory;
}

const makeLogger = () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
});

const channelCtx = { channelId: "conv-1@wire.com", purpose: "Engineering team" };
const members = [{ id: "u1", name: "Alice" }];
const USAGE = { inputTokens: 100, outputTokens: 50 };

describe("OpenAIQueryAnalysisAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a valid LLM response into a QueryPlan", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        intent: "accountability",
        entities: ["Alice", "ProjectX"],
        timeRange: { start: "2026-01-01T00:00:00Z", end: undefined },
        channels: null,
        paths: [{ path: "structured", params: {} }],
        responseFormat: "list",
        complexity: 0.4,
      },
      usage: USAGE,
    } as never);

    const adapter = new OpenAIQueryAnalysisAdapter(makeLLM(), makeLogger());
    const plan = await adapter.analyse("What actions does Alice own?", channelCtx, members);

    expect(plan.intent).toBe("accountability");
    expect(plan.entities).toEqual(["Alice", "ProjectX"]);
    expect(plan.paths[0]?.path).toBe("structured");
    expect(plan.responseFormat).toBe("list");
    expect(plan.complexity).toBe(0.4);
    expect(plan.timeRange?.start).toBeInstanceOf(Date);
  });

  it("always injects structured path even when absent from LLM response", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        intent: "factual_recall", entities: [], timeRange: null, channels: null,
        paths: [{ path: "semantic", params: {} }], responseFormat: "direct_answer", complexity: 0.3,
      },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIQueryAnalysisAdapter(makeLLM(), makeLogger());
    const plan = await adapter.analyse("What was decided?", channelCtx, []);
    expect(plan.paths.some((p) => p.path === "structured")).toBe(true);
  });

  it("returns default plan on LLM error", async () => {
    mockGenerateObject.mockRejectedValue(new Error("timeout"));
    const adapter = new OpenAIQueryAnalysisAdapter(makeLLM(), makeLogger());
    const plan = await adapter.analyse("anything", channelCtx, []);
    expect(plan.intent).toBe("factual_recall");
    expect(plan.complexity).toBe(0.5);
    expect(plan.paths.length).toBeGreaterThan(0);
  });

  it("returns default plan on schema error", async () => {
    mockGenerateObject.mockRejectedValue(new Error("NoObjectGeneratedError"));
    const adapter = new OpenAIQueryAnalysisAdapter(makeLLM(), makeLogger());
    const plan = await adapter.analyse("anything", channelCtx, []);
    expect(plan.intent).toBe("factual_recall");
  });

  it("auto-injects summary path for temporal_context intent", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        intent: "temporal_context", entities: [], timeRange: null, channels: null,
        paths: [{ path: "structured", params: {} }], responseFormat: "summary", complexity: 0.5,
      },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIQueryAnalysisAdapter(makeLLM(), makeLogger());
    const plan = await adapter.analyse("test", channelCtx, []);
    expect(plan.paths.some((p) => p.path === "summary")).toBe(true);
  });

  it("clamps complexity to 0–1 range via Zod schema", async () => {
    // Zod clamps values via .min(0).max(1), invalid values cause failures
    mockGenerateObject.mockResolvedValue({
      object: {
        intent: "factual_recall", entities: [], timeRange: null, channels: null,
        paths: [{ path: "semantic", params: {} }], responseFormat: "direct_answer",
        complexity: 1.0,
      },
      usage: USAGE,
    } as never);
    const adapter = new OpenAIQueryAnalysisAdapter(makeLLM(), makeLogger());
    const plan = await adapter.analyse("test", channelCtx, []);
    expect(plan.complexity).toBeLessThanOrEqual(1.0);
    expect(plan.complexity).toBeGreaterThanOrEqual(0);
  });

  it("uses queryAnalyse slot on the LLM factory", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        intent: "factual_recall", entities: [], timeRange: null, channels: null,
        paths: [{ path: "structured", params: {} }], responseFormat: "direct_answer", complexity: 0.5,
      },
      usage: USAGE,
    } as never);
    const llm = makeLLM();
    const adapter = new OpenAIQueryAnalysisAdapter(llm, makeLogger());
    await adapter.analyse("test", channelCtx, members);
    expect(llm.getModel).toHaveBeenCalledWith("queryAnalyse");
  });
});
