import { describe, expect, it, vi } from "vitest";
import { StructuredRetrievalPath } from "../../src/infrastructure/retrieval/StructuredRetrievalPath";
import { SemanticRetrievalPath } from "../../src/infrastructure/retrieval/SemanticRetrievalPath";
import type { Decision } from "../../src/domain/entities/Decision";
import type { QueryPlan } from "../../src/application/ports/QueryAnalysisPort";

const decision: Decision = {
  id: "DEC-0001", summary: "Carol and Dave agreed to use Terraform", rawMessageId: "source-decision",
  authorId: { id: "alice", domain: "wire.test" }, authorName: "Alice",
  conversationId: { id: "channel", domain: "wire.test" }, context: [], participants: [],
  status: "active", linkedIds: [], attachments: [], tags: [], deleted: false, version: 1,
  timestamp: new Date("2026-09-18T09:00:00Z"), updatedAt: new Date("2026-09-18T09:00:00Z"),
};
const plan: QueryPlan = {
  intent: "factual_recall", entities: ["DEC-0001"], timeRange: null, channels: null,
  paths: [], responseFormat: "direct_answer", complexity: 0.3,
};
const scope = { organisationId: "wire.test", channelId: "channel@wire.test" };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };

async function retrieve(path: string, record: Decision) {
  const decisions = { query: vi.fn().mockResolvedValue([record]), findById: vi.fn().mockResolvedValue(record) };
  const actions = { query: vi.fn().mockResolvedValue([]) };
  const retrieval = path === "structured"
    ? new StructuredRetrievalPath(decisions as never, actions as never)
    : new SemanticRetrievalPath(
      { embed: vi.fn().mockResolvedValue([1]) },
      { findSimilar: vi.fn().mockResolvedValue([{ sourceId: record.id, sourceType: "decision", similarity: 0.9 }]) } as never,
      decisions as never, actions as never, logger,
    );
  return (await retrieval.retrieve(plan, scope))[0].content;
}

describe.each(["structured", "semantic"])("%s decision attribution", path => {
  it.each([undefined, []])("does not promote the recorder when deciders are %j", async decidedBy => {
    const content = await retrieve(path, { ...decision, decidedBy });
    expect(content).toContain("Recorded by: Alice");
    expect(content).not.toContain("Decided by:");
    expect(content).toContain("Carol and Dave agreed to use Terraform");
  });

  it("keeps known deciders separate from the recorder", async () => {
    const content = await retrieve(path, { ...decision, decidedBy: ["Carol", "Dave"] });
    expect(content).toContain("Recorded by: Alice");
    expect(content).toContain("Decided by: Carol, Dave");
    expect(content).not.toContain("Decided by: Alice");
  });

  it("does not invent an identity when both fields are unknown", async () => {
    const content = await retrieve(path, { ...decision, authorName: "", decidedBy: [], summary: "Use Terraform" });
    expect(content).not.toContain("Decided by:");
    expect(content).not.toContain("Alice");
    expect(content).toContain("Recorded by: unknown");
  });
});
