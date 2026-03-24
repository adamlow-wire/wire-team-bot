import { describe, it, expect, vi } from "vitest";
import { OpenAISummarisationAdapter } from "../../src/infrastructure/llm/OpenAISummarisationAdapter";
import type { SignalInput } from "../../src/application/ports/SummarisationPort";

const makeLogger = () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis(),
});

function makeLLM(content: string) {
  return { chatCompletion: vi.fn().mockResolvedValue({ content, model: "test-model", usedFallback: false }) };
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

const validLLMResponse = JSON.stringify({
  summary: "The team had a productive session discussing API direction.",
  keyDecisions: ["DEC-0001"],
  keyActions: ["ACT-0001"],
  activeTopics: ["API"],
  participants: ["Alice", "Bob"],
  sentiment: "productive",
  messageCount: 3,
});

describe("OpenAISummarisationAdapter", () => {
  it("parses a valid LLM response into a SummaryResult", async () => {
    const llm = makeLLM(validLLMResponse);
    const adapter = new OpenAISummarisationAdapter(llm as never, makeLogger());
    const result = await adapter.summarise(channelId, [signal], [fakeDecision as never], [fakeAction as never], null, "daily");

    expect(result.summary).toBe("The team had a productive session discussing API direction.");
    expect(result.keyDecisions).toContain("DEC-0001");
    expect(result.sentiment).toBe("productive");
    expect(result.messageCount).toBe(3);
  });

  it("strips ```json fences before parsing", async () => {
    const llm = makeLLM("```json\n" + validLLMResponse + "\n```");
    const adapter = new OpenAISummarisationAdapter(llm as never, makeLogger());
    const result = await adapter.summarise(channelId, [signal], [], [], null, "daily");
    expect(result.summary).toContain("productive session");
  });

  it("returns fallback summary when LLM throws", async () => {
    const llm = { chatCompletion: vi.fn().mockRejectedValue(new Error("LLM down")) };
    const adapter = new OpenAISummarisationAdapter(llm as never, makeLogger());
    const result = await adapter.summarise(channelId, [signal], [fakeDecision as never], [], null, "daily");
    expect(result.summary).toContain("1 decision(s) recorded");
    expect(result.sentiment).toBe("routine");
  });

  it("returns fallback summary when JSON is malformed", async () => {
    const llm = makeLLM("this is not json at all");
    const adapter = new OpenAISummarisationAdapter(llm as never, makeLogger());
    const result = await adapter.summarise(channelId, [], [], [fakeAction as never], null, "daily");
    expect(result.summary).toContain("1 action(s) tracked");
  });

  it("uses 'routine' sentiment when LLM returns unknown sentiment", async () => {
    const llm = makeLLM(JSON.stringify({ ...JSON.parse(validLLMResponse), sentiment: "chaotic" }));
    const adapter = new OpenAISummarisationAdapter(llm as never, makeLogger());
    const result = await adapter.summarise(channelId, [], [], [], null, "daily");
    expect(result.sentiment).toBe("routine");
  });

  it("uses summarise slot", async () => {
    const llm = makeLLM(validLLMResponse);
    const adapter = new OpenAISummarisationAdapter(llm as never, makeLogger());
    await adapter.summarise(channelId, [signal], [], [], null, "daily");
    const [[slot]] = (llm.chatCompletion as ReturnType<typeof vi.fn>).mock.calls;
    expect(slot).toBe("summarise");
  });

  it("returns fallback with no-activity message when everything is empty", async () => {
    const llm = { chatCompletion: vi.fn().mockRejectedValue(new Error("LLM down")) };
    const adapter = new OpenAISummarisationAdapter(llm as never, makeLogger());
    const result = await adapter.summarise(channelId, [], [], [], null, "daily");
    expect(result.summary).toBe("No significant activity in this period.");
  });
});
