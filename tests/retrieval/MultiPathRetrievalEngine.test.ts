import { describe, it, expect, vi } from "vitest";
import { MultiPathRetrievalEngine } from "../../src/infrastructure/retrieval/MultiPathRetrievalEngine";
import type { RetrievalResult, RetrievalScope } from "../../src/application/ports/RetrievalPort";
import type { QueryPlan } from "../../src/application/ports/QueryAnalysisPort";

const makeLogger = () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis(),
});

function makeResult(id: string, type: RetrievalResult["type"] = "decision"): RetrievalResult {
  return {
    id,
    type,
    content: `${type}: content for ${id}`,
    sourceChannel: "ch@wire.com",
    sourceDate: new Date("2026-03-01"),
    confidence: 0.85,
    pathsMatched: ["structured"],
  };
}

const basePlan: QueryPlan = {
  intent: "factual_recall",
  entities: [],
  timeRange: null,
  channels: null,
  paths: [
    { path: "structured", params: {} },
    { path: "semantic", params: {} },
    { path: "graph", params: {} },
  ],
  responseFormat: "direct_answer",
  complexity: 0.5,
};

const scope: RetrievalScope = { organisationId: "wire.com", channelId: "ch@wire.com" };

function makePaths(structured: RetrievalResult[], semantic: RetrievalResult[], graph: RetrievalResult[], summary: RetrievalResult[] = []) {
  return {
    structured: { retrieve: vi.fn().mockResolvedValue(structured) },
    semantic:   { retrieve: vi.fn().mockResolvedValue(semantic) },
    graph:      { retrieve: vi.fn().mockResolvedValue(graph) },
    summary:    { retrieve: vi.fn().mockResolvedValue(summary) },
  };
}

function makeEngine(paths: ReturnType<typeof makePaths>) {
  return new MultiPathRetrievalEngine(paths.structured as never, paths.semantic as never, paths.graph as never, paths.summary as never, makeLogger());
}

describe("MultiPathRetrievalEngine", () => {
  it("returns results from a single path", async () => {
    const paths = makePaths([makeResult("d1"), makeResult("d2")], [], []);
    const results = await makeEngine(paths).retrieve(basePlan, scope);
    expect(results.length).toBe(2);
    expect(results.map((r) => r.id)).toContain("d1");
  });

  it("deduplicates results found by multiple paths", async () => {
    const shared = makeResult("d1");
    const paths = makePaths([shared], [{ ...shared, pathsMatched: ["semantic"] }], []);
    const results = await makeEngine(paths).retrieve(basePlan, scope);
    const d1 = results.find((r) => r.id === "d1");
    expect(d1).toBeDefined();
    expect(d1!.pathsMatched).toHaveLength(2);
  });

  it("applies 1.5× multi-path boost — multi-path result ranked above single-path", async () => {
    const shared = makeResult("shared");
    const single = makeResult("single");
    const paths = makePaths([shared, single], [{ ...shared, pathsMatched: ["semantic"] }], []);
    const results = await makeEngine(paths).retrieve(basePlan, scope);
    expect(results[0]!.id).toBe("shared");
  });

  it("only runs paths requested in the plan", async () => {
    const planStructuredOnly: QueryPlan = { ...basePlan, paths: [{ path: "structured", params: {} }] };
    const paths = makePaths([makeResult("d1")], [], []);
    await makeEngine(paths).retrieve(planStructuredOnly, scope);
    expect(paths.structured.retrieve).toHaveBeenCalled();
    expect(paths.semantic.retrieve).not.toHaveBeenCalled();
    expect(paths.graph.retrieve).not.toHaveBeenCalled();
  });

  it("continues if one path throws", async () => {
    const paths = makePaths([], [makeResult("s1")], []);
    vi.spyOn(paths.structured, "retrieve").mockRejectedValue(new Error("DB down"));
    const results = await makeEngine(paths).retrieve(basePlan, scope);
    expect(results.some((r) => r.id === "s1")).toBe(true);
  });

  it("returns empty array when all paths return nothing", async () => {
    const paths = makePaths([], [], []);
    const results = await makeEngine(paths).retrieve(basePlan, scope);
    expect(results).toEqual([]);
  });

  it("applies accountability intent boost to actions", async () => {
    const decision = makeResult("dec1", "decision");
    const action = makeResult("act1", "action");
    const accountabilityPlan: QueryPlan = { ...basePlan, intent: "accountability" };
    const paths = makePaths([decision, action], [], []);
    const results = await makeEngine(paths).retrieve(accountabilityPlan, scope);
    expect(results[0]!.id).toBe("act1");
  });

  it("auto-runs summary path for temporal_context intent", async () => {
    const temporalPlan: QueryPlan = {
      ...basePlan,
      intent: "temporal_context",
      paths: [{ path: "structured", params: {} }], // summary NOT in explicit paths
    };
    const summaryResult = makeResult("sum1", "summary");
    const paths = makePaths([makeResult("d1")], [], [], [summaryResult]);
    await makeEngine(paths).retrieve(temporalPlan, scope);
    expect(paths.summary.retrieve).toHaveBeenCalled();
  });
});
