import { it, expect, vi } from "vitest";
import { OpenAIGeneralAnswerAdapter } from "../../src/infrastructure/llm/OpenAIGeneralAnswerAdapter";
import { OpenAIQueryAnalysisAdapter } from "../../src/infrastructure/llm/OpenAIQueryAnalysisAdapter";

it("identifies the current requester separately from earlier participants in both model calls", async () => {
  const llm = { chatCompletion: vi.fn().mockResolvedValue({ content: "Bob owns the checklist.", model: "test", usedFallback: false }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
  const requester = { id: "bob", domain: "wire.test", name: "Bob" };
  const members = [{ id: "alice", domain: "wire.test", name: "Alice" }, requester];
  await new OpenAIGeneralAnswerAdapter(llm as never, logger).answer(
    "What am I responsible for?", ["Alice: I assigned Bob the checklist."], [], members, undefined, 0.5, requester,
  );
  const answerMessages = llm.chatCompletion.mock.calls[0][1];
  expect(answerMessages[0].content).toContain("Never infer the current speaker from earlier messages");
  expect(answerMessages[1].content).toContain(`## Current requester\n${JSON.stringify(requester)}`);
  llm.chatCompletion.mockResolvedValue({ content: "{}", model: "test", usedFallback: false });
  await new OpenAIQueryAnalysisAdapter(llm as never, logger).analyse("What am I responsible for?", { channelId: "channel@wire.test" }, members, requester);
  expect(llm.chatCompletion.mock.calls[1][1][1].content).toContain(`Current requester: ${JSON.stringify(requester)}`);
});
