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
