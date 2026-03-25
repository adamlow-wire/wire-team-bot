import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIQueryAnalysisAdapter } from "../../src/infrastructure/llm/OpenAIQueryAnalysisAdapter";

function makeLLM(content: string) {
  return {
    chatCompletion: vi.fn().mockResolvedValue({ content, model: "test-model", usedFallback: false }),
  };
}

const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
});

const channelCtx = { channelId: "conv-1@wire.com", purpose: "Engineering team" };
const members = [{ id: "u1", name: "Alice" }];

describe("OpenAIQueryAnalysisAdapter", () => {
  it("parses a valid LLM response into a QueryPlan", async () => {
    const llm = makeLLM(JSON.stringify({
      intent: "accountability",
      entities: ["Alice", "ProjectX"],
      timeRange: { start: "2026-01-01T00:00:00Z", end: null },
      channels: null,
      paths: [{ path: "structured", params: {} }],
      responseFormat: "list",
      complexity: 0.4,
    }));

    const adapter = new OpenAIQueryAnalysisAdapter(llm as never, makeLogger());
    const plan = await adapter.analyse("What actions does Alice own?", channelCtx, members);

    expect(plan.intent).toBe("accountability");
    expect(plan.entities).toEqual(["Alice", "ProjectX"]);
    expect(plan.paths[0]?.path).toBe("structured");
    expect(plan.responseFormat).toBe("list");
    expect(plan.complexity).toBe(0.4);
    expect(plan.timeRange?.start).toBeInstanceOf(Date);
  });

  it("strips ```json fences before parsing", async () => {
    const llm = makeLLM("```json\n{\"intent\":\"factual_recall\",\"entities\":[],\"timeRange\":null,\"channels\":null,\"paths\":[{\"path\":\"semantic\",\"params\":{}}],\"responseFormat\":\"direct_answer\",\"complexity\":0.3}\n```");
    const adapter = new OpenAIQueryAnalysisAdapter(llm as never, makeLogger());
    const plan = await adapter.analyse("What was decided?", channelCtx, []);
    expect(plan.intent).toBe("factual_recall");
    expect(plan.paths[0]?.path).toBe("semantic");
  });

  it("returns default plan on LLM error", async () => {
    const llm = { chatCompletion: vi.fn().mockRejectedValue(new Error("timeout")) };
    const adapter = new OpenAIQueryAnalysisAdapter(llm as never, makeLogger());
    const plan = await adapter.analyse("anything", channelCtx, []);
    expect(plan.intent).toBe("factual_recall");
    expect(plan.complexity).toBe(0.5);
    expect(plan.paths.length).toBeGreaterThan(0);
  });

  it("returns default plan on malformed JSON", async () => {
    const llm = makeLLM("not json at all");
    const adapter = new OpenAIQueryAnalysisAdapter(llm as never, makeLogger());
    const plan = await adapter.analyse("anything", channelCtx, []);
    expect(plan.intent).toBe("factual_recall");
  });

  it("falls back to valid paths when unknown path type returned", async () => {
    const llm = makeLLM(JSON.stringify({
      intent: "factual_recall",
      entities: [],
      timeRange: null,
      channels: null,
      paths: [{ path: "invalid_path", params: {} }],
      responseFormat: "direct_answer",
      complexity: 0.5,
    }));
    const adapter = new OpenAIQueryAnalysisAdapter(llm as never, makeLogger());
    const plan = await adapter.analyse("test", channelCtx, []);
    // invalid path filtered out, falls back to defaults
    expect(plan.paths.every((p) => ["structured", "semantic", "graph", "summary"].includes(p.path))).toBe(true);
  });

  it("clamps complexity to 0–1 range", async () => {
    const llm = makeLLM(JSON.stringify({
      intent: "factual_recall", entities: [], timeRange: null, channels: null,
      paths: [{ path: "semantic", params: {} }], responseFormat: "direct_answer",
      complexity: 5.0,
    }));
    const adapter = new OpenAIQueryAnalysisAdapter(llm as never, makeLogger());
    const plan = await adapter.analyse("test", channelCtx, []);
    expect(plan.complexity).toBe(1.0);
  });

  it("uses queryAnalyse slot on the LLM factory", async () => {
    const llm = makeLLM(JSON.stringify({
      intent: "factual_recall", entities: [], timeRange: null, channels: null,
      paths: [{ path: "structured", params: {} }], responseFormat: "direct_answer", complexity: 0.5,
    }));
    const adapter = new OpenAIQueryAnalysisAdapter(llm as never, makeLogger());
    await adapter.analyse("test", channelCtx, members);
    expect(llm.chatCompletion).toHaveBeenCalledWith(
      "queryAnalyse",
      expect.any(Array),
      expect.any(Object),
    );
  });
});
