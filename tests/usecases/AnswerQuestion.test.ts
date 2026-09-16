import { it, expect, vi } from "vitest";
import { AnswerQuestion } from "../../src/application/usecases/general/AnswerQuestion";

it("passes the current caller to retrieval planning and answering without changing channel scope", async () => {
  const requester = { id: "bob", domain: "wire.test", name: "Bob" };
  const general = { answer: vi.fn().mockResolvedValue("Bob owns the checklist.") };
  const wire = { sendPlainText: vi.fn() };
  const plan = { complexity: 0.5 };
  const analysis = { analyse: vi.fn().mockResolvedValue(plan) };
  const retrieval = { retrieve: vi.fn().mockResolvedValue([]) };
  const context = ["Alice: I logged a task for Bob."];
  const members = [{ id: "alice", domain: "wire.test", name: "Alice" }, requester];
  await new AnswerQuestion(general, wire as never, analysis, retrieval).execute({
    question: "What am I responsible for?", requester, conversationContext: context,
    conversationId: { id: "channel", domain: "wire.test" }, replyToMessageId: "q", members,
    channelId: "channel@wire.test", orgId: "wire.test",
  });
  expect(analysis.analyse).toHaveBeenCalledWith("What am I responsible for?", expect.any(Object), members, requester);
  expect(retrieval.retrieve).toHaveBeenCalledWith(plan, { channelId: "channel@wire.test", organisationId: "wire.test", userId: undefined });
  expect(general.answer).toHaveBeenCalledWith("What am I responsible for?", context, [], members, undefined, 0.5, requester);
});
