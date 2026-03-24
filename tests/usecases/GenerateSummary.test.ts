import { describe, it, expect, vi, beforeEach } from "vitest";
import { GenerateSummary } from "../../src/application/usecases/general/GenerateSummary";
import type { ConversationSummary } from "../../src/domain/entities/ConversationSummary";

const makeLogger = () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis(),
});

const channelId = "conv-1@wire.com";
const orgId = "wire.com";
const periodStart = new Date("2026-03-10T00:00:00Z");
const periodEnd = new Date("2026-03-11T00:00:00Z");

const fakeSignal = {
  id: "sig-1",
  channelId,
  organisationId: orgId,
  signalType: "discussion_topic" as const,
  summary: "Team discussed the API redesign",
  occurredAt: new Date("2026-03-10T10:00:00Z"),
  participants: ["Alice", "Bob"],
  tags: ["api"],
  confidence: 0.9,
};

const fakeDecision = {
  id: "DEC-0001",
  organisationId: orgId,
  conversationId: { id: "conv-1", domain: "wire.com" },
  summary: "Use REST over GraphQL",
  rationale: null,
  decidedAt: new Date("2026-03-10T09:00:00Z"),
  timestamp: new Date("2026-03-10T09:00:00Z"),
  authorId: { id: "u1", domain: "wire.com" },
  authorName: "Alice",
  status: "active" as const,
  tags: [],
  deleted: false,
  rawMessageId: "m1",
  supersededBy: null,
  supersedes: null,
};

const fakeAction = {
  id: "ACT-0001",
  organisationId: orgId,
  conversationId: { id: "conv-1", domain: "wire.com" },
  description: "Write API docs",
  assigneeId: { id: "u2", domain: "wire.com" },
  assigneeName: "Bob",
  status: "open" as const,
  timestamp: new Date("2026-03-10T11:00:00Z"),
  deadline: null,
  stalenessAt: null,
  lastStatusCheck: null,
  completionNote: null,
  tags: [],
  deleted: false,
  rawMessageId: "m2",
  confidence: 0.8,
};

const summaryResult = {
  summary: "Productive session discussing API approach.",
  keyDecisions: ["Use REST"],
  keyActions: ["Write API docs"],
  activeTopics: ["API"],
  participants: ["Alice", "Bob"],
  sentiment: "productive" as const,
  messageCount: 5,
  modelVersion: "test",
};

function makeDeps(overrides = {}) {
  return {
    summarise: {
      summarise: vi.fn().mockResolvedValue(summaryResult),
    },
    signalRepo: {
      query: vi.fn().mockResolvedValue([fakeSignal]),
    },
    decisionRepo: {
      query: vi.fn().mockResolvedValue([fakeDecision]),
    },
    actionRepo: {
      query: vi.fn().mockResolvedValue([fakeAction]),
    },
    summaryRepo: {
      findLatest: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockImplementation((data: unknown) =>
        Promise.resolve({ id: "sum-1", generatedAt: new Date(), ...(data as object) }),
      ),
    },
    logger: makeLogger(),
    ...overrides,
  };
}

describe("GenerateSummary", () => {
  it("returns a persisted summary when activity exists", async () => {
    const deps = makeDeps();
    const uc = new GenerateSummary(
      deps.summarise as never,
      deps.signalRepo as never,
      deps.decisionRepo as never,
      deps.actionRepo as never,
      deps.summaryRepo as never,
      deps.logger,
    );
    const result = await uc.execute({ channelId, organisationId: orgId, granularity: "daily", periodStart, periodEnd });
    expect(result).not.toBeNull();
    expect(result!.summary).toBe(summaryResult.summary);
    expect(deps.summaryRepo.save).toHaveBeenCalledOnce();
  });

  it("returns null when there is no activity in the period", async () => {
    const deps = makeDeps({
      signalRepo: { query: vi.fn().mockResolvedValue([]) },
      decisionRepo: { query: vi.fn().mockResolvedValue([]) },
      actionRepo: { query: vi.fn().mockResolvedValue([]) },
    });
    const uc = new GenerateSummary(
      deps.summarise as never, deps.signalRepo as never, deps.decisionRepo as never,
      deps.actionRepo as never, deps.summaryRepo as never, deps.logger,
    );
    const result = await uc.execute({ channelId, organisationId: orgId, granularity: "daily", periodStart, periodEnd });
    expect(result).toBeNull();
    expect(deps.summaryRepo.save).not.toHaveBeenCalled();
  });

  it("passes prior summary as rolling context", async () => {
    const priorSummary = { id: "sum-0", summary: "Previous day was quiet.", periodEnd: new Date("2026-03-09T23:59:59Z"), generatedAt: new Date() };
    const deps = makeDeps({
      summaryRepo: {
        findLatest: vi.fn().mockResolvedValue(priorSummary),
        save: vi.fn().mockImplementation((d: unknown) => Promise.resolve({ id: "sum-1", generatedAt: new Date(), ...(d as object) })),
      },
    });
    const uc = new GenerateSummary(
      deps.summarise as never, deps.signalRepo as never, deps.decisionRepo as never,
      deps.actionRepo as never, deps.summaryRepo as never, deps.logger,
    );
    await uc.execute({ channelId, organisationId: orgId, granularity: "daily", periodStart, periodEnd });
    const callArgs = (deps.summarise.summarise as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[4]).toBe(priorSummary.summary); // priorSummary arg
  });

  it("returns null when the LLM summarisation fails", async () => {
    const deps = makeDeps({
      summarise: { summarise: vi.fn().mockRejectedValue(new Error("LLM down")) },
    });
    const uc = new GenerateSummary(
      deps.summarise as never, deps.signalRepo as never, deps.decisionRepo as never,
      deps.actionRepo as never, deps.summaryRepo as never, deps.logger,
    );
    const result = await uc.execute({ channelId, organisationId: orgId, granularity: "daily", periodStart, periodEnd });
    expect(result).toBeNull();
  });

  it("filters decisions/actions to the period window", async () => {
    const outsideDecision = { ...fakeDecision, decidedAt: new Date("2026-03-09T08:00:00Z"), timestamp: new Date("2026-03-09T08:00:00Z") };
    const deps = makeDeps({
      decisionRepo: { query: vi.fn().mockResolvedValue([outsideDecision]) },
      actionRepo: { query: vi.fn().mockResolvedValue([]) },
      // signals still present so we don't bail on empty check
      signalRepo: { query: vi.fn().mockResolvedValue([fakeSignal]) },
    });
    const uc = new GenerateSummary(
      deps.summarise as never, deps.signalRepo as never, deps.decisionRepo as never,
      deps.actionRepo as never, deps.summaryRepo as never, deps.logger,
    );
    await uc.execute({ channelId, organisationId: orgId, granularity: "daily", periodStart, periodEnd });
    const callArgs = (deps.summarise.summarise as ReturnType<typeof vi.fn>).mock.calls[0];
    const decisionsArg = callArgs[2] as unknown[];
    expect(decisionsArg).toHaveLength(0); // outside decision was filtered
  });
});
