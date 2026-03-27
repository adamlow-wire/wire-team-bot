import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAISummarisationAdapter } from "../../src/infrastructure/llm/OpenAISummarisationAdapter";
import type { VercelAISlotFactory } from "../../src/infrastructure/llm/VercelAISlotFactory";
import type { SignalInput } from "../../src/application/ports/SummarisationPort";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";
const mockGenerateObject = vi.mocked(generateObject);

const makeLogger = () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis(),
});

function makeLLM(): VercelAISlotFactory {
  return {
    getModel: vi.fn().mockReturnValue("test-model"),
    getFallbackModel: vi.fn(),
    getRespondModel: vi.fn(),
    timeoutMs: 10000,
  } as unknown as VercelAISlotFactory;
}

const channelId = "conv-1@wire.com";
const signal: SignalInput = {
  signalType: "discussion_topic",
  summary: "Team debated API strategy",
  occurredAt: new Date("2026-03-10T10:00:00Z"),
  participants: ["Alice", "Bob"],
  tags: ["api"],
};

const fakeDecision = {
  id: "DEC-0001",
  summary: "Use REST",
  decidedAt: new Date("2026-03-10T09:00:00Z"),
  decidedBy: ["Alice"],
};

const fakeAction = {
  id: "ACT-0001",
  description: "Write docs",
  assigneeId: { id: "u1", domain: "wire.com" },
  assigneeName: "Bob",
  status: "open",
  deadline: null,
};

const USAGE = { inputTokens: 200, outputTokens: 100 };

const validObject = {
  summary: "The team had a productive session discussing API direction.",
  keyDecisions: ["DEC-0001"],
  keyActions: ["ACT-0001"],
  activeTopics: ["API"],
  participants: ["Alice", "Bob"],
  sentiment: "productive" as const,
  messageCount: 3,
};

describe("OpenAISummarisationAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a valid LLM response into a SummaryResult", async () => {
    mockGenerateObject.mockResolvedValue({ object: validObject, usage: USAGE } as never);
    const adapter = new OpenAISummarisationAdapter(makeLLM(), makeLogger());
    const result = await adapter.summarise(channelId, [signal], [fakeDecision as never], [fakeAction as never], null, "daily");

    expect(result.summary).toBe("The team had a productive session discussing API direction.");
    expect(result.keyDecisions).toContain("DEC-0001");
    expect(result.sentiment).toBe("productive");
    expect(result.messageCount).toBe(3);
  });

  it("returns fallback summary when LLM throws", async () => {
    mockGenerateObject.mockRejectedValue(new Error("LLM down"));
    const adapter = new OpenAISummarisationAdapter(makeLLM(), makeLogger());
    const result = await adapter.summarise(channelId, [signal], [fakeDecision as never], [], null, "daily");
    expect(result.summary).toContain("1 decision(s) recorded");
    expect(result.sentiment).toBe("routine");
  });

  it("returns fallback summary on schema error", async () => {
    mockGenerateObject.mockRejectedValue(new Error("NoObjectGeneratedError"));
    const adapter = new OpenAISummarisationAdapter(makeLLM(), makeLogger());
    const result = await adapter.summarise(channelId, [], [], [fakeAction as never], null, "daily");
    expect(result.summary).toContain("1 action(s) tracked");
  });

  it("uses 'routine' as default sentiment when Zod defaults apply", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { ...validObject, sentiment: "routine" as const },
      usage: USAGE,
    } as never);
    const adapter = new OpenAISummarisationAdapter(makeLLM(), makeLogger());
    const result = await adapter.summarise(channelId, [], [], [], null, "daily");
    expect(result.sentiment).toBe("routine");
  });

  it("uses summarise slot on the LLM factory", async () => {
    mockGenerateObject.mockResolvedValue({ object: validObject, usage: USAGE } as never);
    const llm = makeLLM();
    const adapter = new OpenAISummarisationAdapter(llm, makeLogger());
    await adapter.summarise(channelId, [signal], [], [], null, "daily");
    expect(llm.getModel).toHaveBeenCalledWith("summarise");
  });

  it("returns fallback with no-activity message when everything is empty", async () => {
    mockGenerateObject.mockRejectedValue(new Error("LLM down"));
    const adapter = new OpenAISummarisationAdapter(makeLLM(), makeLogger());
    const result = await adapter.summarise(channelId, [], [], [], null, "daily");
    expect(result.summary).toBe("No significant activity in this period.");
  });
});
