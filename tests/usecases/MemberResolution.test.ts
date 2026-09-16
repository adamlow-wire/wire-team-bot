import { it, expect } from "vitest";
import { InMemoryMemberCache } from "../../src/infrastructure/services/InMemoryMemberCache";
import { MemberCacheUserResolutionService } from "../../src/infrastructure/services/MemberCacheUserResolutionService";

it("resolves handles only in their qualified conversation and clears stale handles on refresh", async () => {
  const cache = new InMemoryMemberCache();
  const conversationId = { id: "channel", domain: "one.test" };
  const userId = { id: "second", domain: "one.test" };
  cache.setMembers(conversationId, [{ userId, role: "member", name: "Adam (Test)", handle: "second_test" }]);
  const service = new MemberCacheUserResolutionService(cache);
  expect(await service.resolveByHandleOrName("@SECOND_TEST", { conversationId })).toEqual({ userId, ambiguous: false });
  expect((await service.resolveByHandleOrName("@second_test", { conversationId: { ...conversationId, domain: "other.test" } })).userId).toBeNull();
  cache.updateMemberName(conversationId, userId, "Adam (Test)", "new_handle");
  expect((await service.resolveByHandleOrName("@second_test", { conversationId })).userId).toBeNull();
  expect((await service.resolveByHandleOrName("@new_handle", { conversationId })).userId).toEqual(userId);
  cache.updateMemberName(conversationId, userId, "Adam (Test)");
  expect((await service.resolveByHandleOrName("@new_handle", { conversationId })).userId).toBeNull();
  expect((await service.resolveByHandleOrName("Adam (Test)", { conversationId })).userId).toEqual(userId);
});

it("rejects a handle/display-name collision instead of selecting a person", async () => {
  const cache = new InMemoryMemberCache();
  const conversationId = { id: "channel", domain: "one.test" };
  cache.setMembers(conversationId, [
    { userId: { id: "a", domain: "one.test" }, role: "member", name: "Adam (Test)", handle: "second_test" },
    { userId: { id: "b", domain: "one.test" }, role: "member", name: "second_test" },
  ]);
  expect(await new MemberCacheUserResolutionService(cache).resolveByHandleOrName("@second_test", { conversationId }))
    .toMatchObject({ userId: null, ambiguous: true });
});
