import { describe, it, expect, vi } from "vitest";
import { StructuredRetrievalPath } from "../../src/infrastructure/retrieval/StructuredRetrievalPath";
import type { Decision } from "../../src/domain/entities/Decision";
import type { Action } from "../../src/domain/entities/Action";
import type { QueryPlan } from "../../src/application/ports/QueryAnalysisPort";
import type { RetrievalScope } from "../../src/application/ports/RetrievalPort";

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "DEC-0001",
    summary: "We will use TypeScript",
    rawMessageId: "msg-1",
    context: [],
    authorId: { id: "u1", domain: "wire.com" },
    authorName: "Alice",
    participants: [],
    conversationId: { id: "conv-1", domain: "wire.com" },
    status: "active",
    supersededBy: null,
    supersedes: null,
    linkedIds: [],
    attachments: [],
    tags: ["tech", "lang"],
    timestamp: new Date("2026-02-01"),
    updatedAt: new Date("2026-02-01"),
    deleted: false,
    version: 1,
    decidedAt: new Date("2026-02-01"),
    decidedBy: ["Alice"],
    confidence: 0.9,
    ...overrides,
  };
}

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: "ACT-0001",
    description: "Set up CI pipeline",
    rawMessageId: "msg-2",
    assigneeId: { id: "u2", domain: "wire.com" },
    assigneeName: "Bob",
    creatorId: { id: "u1", domain: "wire.com" },
    authorName: "Alice",
    conversationId: { id: "conv-1", domain: "wire.com" },
    deadline: new Date("2026-03-15"),
    status: "open",
    linkedIds: [],
    reminderAt: [],
    completionNote: null,
    timestamp: new Date("2026-02-10"),
    updatedAt: new Date("2026-02-10"),
    tags: [],
    deleted: false,
    version: 1,
    actionConfidence: 0.85,
    ...overrides,
  };
}

const basePlan: QueryPlan = {
  intent: "factual_recall",
  entities: [],
  timeRange: null,
  channels: null,
  paths: [{ path: "structured", params: {} }],
  responseFormat: "direct_answer",
  complexity: 0.3,
};

const scope: RetrievalScope = { organisationId: "wire.com", channelId: "conv-1@wire.com" };

describe("StructuredRetrievalPath", () => {
  it("returns decisions and actions for channel", async () => {
    const decisionRepo = { query: vi.fn().mockResolvedValue([makeDecision()]), findById: vi.fn() };
    const actionRepo = { query: vi.fn().mockResolvedValue([makeAction()]), findById: vi.fn() };
    const path = new StructuredRetrievalPath(decisionRepo as never, actionRepo as never);

    const results = await path.retrieve(basePlan, scope);

    expect(results.length).toBe(2);
    expect(results.some((r) => r.type === "decision")).toBe(true);
    expect(results.some((r) => r.type === "action")).toBe(true);
  });

  it("passes searchText derived from entities in plan", async () => {
    const decisionRepo = { query: vi.fn().mockResolvedValue([]), findById: vi.fn() };
    const actionRepo = { query: vi.fn().mockResolvedValue([]), findById: vi.fn() };
    const path = new StructuredRetrievalPath(decisionRepo as never, actionRepo as never);

    await path.retrieve({ ...basePlan, entities: ["Alice", "ProjectX"] }, scope);

    expect(decisionRepo.query).toHaveBeenCalledWith(
      expect.objectContaining({ searchText: "Alice ProjectX" }),
    );
  });

  it("returns empty array when no channelId in scope", async () => {
    const decisionRepo = { query: vi.fn(), findById: vi.fn() };
    const actionRepo = { query: vi.fn(), findById: vi.fn() };
    const path = new StructuredRetrievalPath(decisionRepo as never, actionRepo as never);

    const results = await path.retrieve(basePlan, { organisationId: "wire.com" });
    expect(results).toEqual([]);
    expect(decisionRepo.query).not.toHaveBeenCalled();
  });

  it("filters by time range", async () => {
    const oldDecision = makeDecision({ id: "DEC-OLD", decidedAt: new Date("2025-01-01"), timestamp: new Date("2025-01-01") });
    const newDecision = makeDecision({ id: "DEC-NEW", decidedAt: new Date("2026-02-01"), timestamp: new Date("2026-02-01") });
    const decisionRepo = { query: vi.fn().mockResolvedValue([oldDecision, newDecision]), findById: vi.fn() };
    const actionRepo = { query: vi.fn().mockResolvedValue([]), findById: vi.fn() };
    const path = new StructuredRetrievalPath(decisionRepo as never, actionRepo as never);

    const planWithRange: QueryPlan = {
      ...basePlan,
      timeRange: { start: new Date("2026-01-01") },
    };
    const results = await path.retrieve(planWithRange, scope);

    expect(results.find((r) => r.id === "DEC-OLD")).toBeUndefined();
    expect(results.find((r) => r.id === "DEC-NEW")).toBeDefined();
  });

  it("includes rationale in decision content when present", async () => {
    const d = makeDecision({ rationale: "For consistency across the codebase" });
    const decisionRepo = { query: vi.fn().mockResolvedValue([d]), findById: vi.fn() };
    const actionRepo = { query: vi.fn().mockResolvedValue([]), findById: vi.fn() };
    const path = new StructuredRetrievalPath(decisionRepo as never, actionRepo as never);

    const results = await path.retrieve(basePlan, scope);
    const decision = results.find((r) => r.type === "decision");
    expect(decision?.content).toContain("For consistency");
  });

  it("continues gracefully if decisionRepo throws", async () => {
    const decisionRepo = { query: vi.fn().mockRejectedValue(new Error("DB error")), findById: vi.fn() };
    const actionRepo = { query: vi.fn().mockResolvedValue([makeAction()]), findById: vi.fn() };
    const path = new StructuredRetrievalPath(decisionRepo as never, actionRepo as never);

    const results = await path.retrieve(basePlan, scope);
    expect(results.some((r) => r.type === "action")).toBe(true);
  });
});
