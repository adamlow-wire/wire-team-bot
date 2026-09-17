import { it, expect, vi } from "vitest";
import { CreateActionFromExplicit } from "../../src/application/usecases/actions/CreateActionFromExplicit";
it.each([false,true])("does not guess an unknown/ambiguous assignee (%s)",async ambiguous=>{
  const repo={nextId:vi.fn(),query:vi.fn().mockResolvedValue([]),create:vi.fn()};
  const resolution={resolveByHandleOrName:vi.fn().mockResolvedValue({userId:null,ambiguous})};
  const wire={sendPlainText:vi.fn()};
  const audit={append:vi.fn()};
  const useCase=new CreateActionFromExplicit(repo as never,{} as never,{} as never,resolution,wire as never,audit,{} as never);
  expect(await useCase.execute({conversationId:{id:"c",domain:"d"},creatorId:{id:"alice",domain:"d"},authorName:"Alice",rawMessageId:"m",description:"Review",assigneeReference:"unknown"})).toBeNull();
  expect(repo.create).not.toHaveBeenCalled();
  expect(audit.append).not.toHaveBeenCalled();
  expect(wire.sendPlainText).toHaveBeenCalled();
});
it("stores the parsed deadline instead of only echoing it in the description", async () => {
  const due=new Date("2026-10-02T09:00:00Z");
  const repo={nextId:vi.fn().mockResolvedValue("ACT-1"),query:vi.fn().mockResolvedValue([]),create:vi.fn(async a=>a)};
  const actor={id:"alice",domain:"d"};
  const wire={sendPlainText:vi.fn()};
  const logger={info:vi.fn()};
  const useCase=new CreateActionFromExplicit(repo as never,{get:vi.fn().mockResolvedValue({timezone:"UTC"})} as never,{parse:vi.fn().mockReturnValue({value:due})} as never,{resolveByHandleOrName:vi.fn()},wire as never,{append:vi.fn()},logger as never);
  const result=await useCase.execute({conversationId:{id:"c",domain:"d"},creatorId:actor,authorName:"Alice",rawMessageId:"m",description:"Review",deadlineText:"Friday"});
  expect(result?.deadline).toEqual(due);
  expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({deadline:due}));
});

it.each(["match", "wrong-domain", "absent"])("uses a scoped structured assignee without a name fallback: %s", async variant => {
  const target = { id: "target", domain: "remote.test" };
  const resolved = variant === "match" ? target : variant === "wrong-domain" ? { ...target, domain: "other.test" } : null;
  const repo = { nextId: vi.fn().mockResolvedValue("ACT-1"), query: vi.fn().mockResolvedValue([]), create: vi.fn(async a => a) };
  const resolution = { resolveByHandleOrName: vi.fn().mockResolvedValue({ userId: resolved, ambiguous: false }) };
  const audit = { append: vi.fn() };
  const useCase = new CreateActionFromExplicit(repo as never, {} as never, {} as never, resolution, { sendPlainText: vi.fn() } as never, audit, { info: vi.fn() } as never);
  const conversationId = { id: "channel", domain: "local.test" };
  const result = await useCase.execute({ conversationId, creatorId: { id: "sender", domain: "local.test" }, authorName: "Sender", rawMessageId: "source", description: "prepare slides", assigneeReference: "@Duplicate name", assigneeId: target });
  expect(resolution.resolveByHandleOrName).toHaveBeenCalledExactlyOnceWith("@Duplicate name", { conversationId, userId: target });
  if (variant === "match") {
    expect(result?.assigneeId).toEqual(target);
    expect(result?.assigneeName).toBe("@Duplicate name");
    expect(audit.append).toHaveBeenCalledOnce();
  } else {
    expect(result).toBeNull();
    expect(repo.create).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  }
});
