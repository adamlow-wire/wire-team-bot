/**
 * Contract tests for WireEventRouter.
 *
 * These tests verify that the router correctly maps incoming SDK text messages
 * to the expected application use-case calls. They use fully-stubbed use cases
 * and ports — no DB, no network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WireEventRouter } from "../../src/infrastructure/wire/WireEventRouter";
import type { WireEventRouterDeps } from "../../src/infrastructure/wire/WireEventRouter";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const sender: QualifiedId = { id: "user-1", domain: "wire.com" };

function makeMessage(text: string, id = "msg-1") {
  return { id, text, conversationId: convId, sender };
}

function makeDeps(overrides: Partial<WireEventRouterDeps> = {}): WireEventRouterDeps {
  return {
    logger: { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // Decisions
    logDecision: { execute: vi.fn().mockResolvedValue({ id: "DEC-0001" }) },
    searchDecisions: { execute: vi.fn().mockResolvedValue(undefined) },
    listDecisions: { execute: vi.fn().mockResolvedValue(undefined) },
    supersedeDecision: { execute: vi.fn().mockResolvedValue(null) },
    revokeDecision: { execute: vi.fn().mockResolvedValue(null) },
    // Actions
    createActionFromExplicit: { execute: vi.fn().mockResolvedValue({ id: "ACT-0001" }) },
    updateActionStatus: { execute: vi.fn().mockResolvedValue(null) },
    reassignAction: { execute: vi.fn().mockResolvedValue(null) },
    updateActionDeadline: { execute: vi.fn().mockResolvedValue(null) },
    listMyActions: { execute: vi.fn().mockResolvedValue([]) },
    listTeamActions: { execute: vi.fn().mockResolvedValue([]) },
    listOverdueActions: { execute: vi.fn().mockResolvedValue([]) },
    // Reminders
    createReminder: { execute: vi.fn().mockResolvedValue({ id: "REM-0001" }) },
    listMyReminders: { execute: vi.fn().mockResolvedValue([]) },
    cancelReminder: { execute: vi.fn().mockResolvedValue(null) },
    snoozeReminder: { execute: vi.fn().mockResolvedValue(null) },
    // General
    answerQuestion: { execute: vi.fn().mockResolvedValue(undefined) },
    // Infrastructure identity
    botUserId: { id: "bot-1", domain: "wire.com" },
    wireOutbound: {
      sendPlainText: vi.fn().mockResolvedValue(undefined),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    },
    messageBuffer: { push: vi.fn(), getLastN: vi.fn().mockReturnValue([]) },
    dateTimeService: { parse: vi.fn().mockReturnValue(null) },
    memberCache: {
      setMembers: vi.fn(), addMembers: vi.fn(), getMembers: vi.fn().mockReturnValue([]),
      removeMembers: vi.fn(), clearConversation: vi.fn(),
    },
    conversationConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    channelConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn(), setState: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]) },
    slidingWindow: { push: vi.fn(), getWindow: vi.fn().mockReturnValue([]), flush: vi.fn(), clear: vi.fn() },
    scheduler: { schedule: vi.fn(), cancel: vi.fn(), setHandler: vi.fn() },
    secretModeInactivityMs: 600_000,
    ...overrides,
  } as unknown as WireEventRouterDeps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fast-path routing (no LLM call)
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: fast-path routing", () => {
  let deps: WireEventRouterDeps;
  let router: WireEventRouter;

  beforeEach(() => {
    deps = makeDeps();
    router = new WireEventRouter(deps);
  });

  it("'TASK-0001 done' → sends graceful redirect (tasks consolidated)", async () => {
    await router.onTextMessageReceived(makeMessage("TASK-0001 done"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("actions"),
      expect.anything(),
    );
  });

  it("'close TASK-0001' → sends graceful redirect (tasks consolidated)", async () => {
    await router.onTextMessageReceived(makeMessage("close TASK-0001"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("actions"),
      expect.anything(),
    );
  });

  it("'ACT-0001 done' → updateActionStatus", async () => {
    await router.onTextMessageReceived(makeMessage("ACT-0001 done"));
    expect(deps.updateActionStatus.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "ACT-0001", newStatus: "done" }),
    );
  });

  it("'close ACT-0001' → updateActionStatus with status done", async () => {
    await router.onTextMessageReceived(makeMessage("close ACT-0001"));
    expect(deps.updateActionStatus.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "ACT-0001", newStatus: "done" }),
    );
  });

  it("'ACT-0001 reassign to @bob' → reassignAction", async () => {
    await router.onTextMessageReceived(makeMessage("ACT-0001 reassign to @bob"));
    expect(deps.reassignAction.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "ACT-0001", newAssigneeReference: "@bob" }),
    );
  });

  it("'assign ACT-0001 to mark' → reassignAction", async () => {
    await router.onTextMessageReceived(makeMessage("assign ACT-0001 to mark"));
    expect(deps.reassignAction.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "ACT-0001", newAssigneeReference: "mark" }),
    );
  });

  it("'TASK-0001 reassign to alice' → sends graceful redirect (tasks consolidated)", async () => {
    await router.onTextMessageReceived(makeMessage("TASK-0001 reassign to alice"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("actions"),
      expect.anything(),
    );
  });

  it("'revoke DEC-0001 wrong call' → revokeDecision", async () => {
    await router.onTextMessageReceived(makeMessage("revoke DEC-0001 wrong call"));
    expect(deps.revokeDecision.execute).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: "DEC-0001", reason: "wrong call", actorId: sender }),
    );
  });

  it("'cancel REM-0001' → cancelReminder fast-path", async () => {
    await router.onTextMessageReceived(makeMessage("cancel REM-0001"));
    expect(deps.cancelReminder.execute).toHaveBeenCalledWith(
      expect.objectContaining({ reminderId: "REM-0001" }),
    );
  });

  it("'forget KB-0001' → sends graceful message (KB being rebuilt)", async () => {
    await router.onTextMessageReceived(makeMessage("forget KB-0001"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringMatching(/knowledge|rebuilt/i),
      expect.anything(),
    );
  });

  it("'update KB-0001 new text' → sends graceful message (KB being rebuilt)", async () => {
    await router.onTextMessageReceived(makeMessage("update KB-0001 new text"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringMatching(/knowledge|rebuilt/i),
      expect.anything(),
    );
  });

  it("'list decisions' exact-match → listDecisions", async () => {
    await router.onTextMessageReceived(makeMessage("list decisions"));
    expect(deps.listDecisions.execute).toHaveBeenCalledOnce();
  });

  it("'my tasks' exact-match → redirects to listMyActions", async () => {
    await router.onTextMessageReceived(makeMessage("my tasks"));
    expect(deps.listMyActions.execute).toHaveBeenCalledOnce();
  });

  it("'team tasks' exact-match → redirects to listTeamActions", async () => {
    await router.onTextMessageReceived(makeMessage("team tasks"));
    expect(deps.listTeamActions.execute).toHaveBeenCalledOnce();
  });

  it("'my actions' exact-match → listMyActions", async () => {
    await router.onTextMessageReceived(makeMessage("my actions"));
    expect(deps.listMyActions.execute).toHaveBeenCalledOnce();
  });

  it("'overdue actions' exact-match → listOverdueActions", async () => {
    await router.onTextMessageReceived(makeMessage("overdue actions"));
    expect(deps.listOverdueActions.execute).toHaveBeenCalledOnce();
  });

  it("'show reminders' exact-match → listMyReminders", async () => {
    await router.onTextMessageReceived(makeMessage("show reminders"));
    expect(deps.listMyReminders.execute).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Explicit-command routing (no LLM)
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: explicit command routing", () => {
  it("decision: <text> → logDecision", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("decision: Use Postgres"));
    expect(deps.logDecision.execute).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Use Postgres" }),
    );
  });

  it("action: <text> → createActionFromExplicit", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("action: Write the spec"));
    expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Write the spec" }),
    );
  });

  it("decisions about <query> → searchDecisions", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("decisions about auth"));
    expect(deps.searchDecisions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ searchText: "auth" }),
    );
  });

  it("search decisions <query> → searchDecisions", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("search decisions rate limiting"));
    expect(deps.searchDecisions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ searchText: "rate limiting" }),
    );
  });

  it("remind me <time> to <desc> with parseable time → createReminder", async () => {
    const parsedDate = new Date("2026-03-16T15:00:00Z");
    const deps = makeDeps({
      dateTimeService: { parse: vi.fn().mockReturnValue({ value: parsedDate }) },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("remind me at 3pm to call John"));
    expect(deps.createReminder.execute).toHaveBeenCalledWith(
      expect.objectContaining({ description: "call John", triggerAt: parsedDate }),
    );
  });

  it("remind me <time> to <desc> with unparseable time → error, no reminder created", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("remind me someday to call John"));
    expect(deps.createReminder.execute).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("couldn't parse"),
      expect.anything(),
    );
  });

  it("non-command message without bot mention → bot stays silent", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("yes its set up for tomorrow"));
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendCompositePrompt).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// General behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: general behaviour", () => {
  let deps: WireEventRouterDeps;
  let router: WireEventRouter;

  beforeEach(() => {
    deps = makeDeps();
    router = new WireEventRouter(deps);
  });

  it("pushes every message to the message buffer", async () => {
    await router.onTextMessageReceived(makeMessage("hello world"));
    expect(deps.messageBuffer.push).toHaveBeenCalledWith(convId, expect.objectContaining({ text: "hello world" }));
  });

  it("sends error reply when a use case throws", async () => {
    const d = makeDeps();
    vi.mocked(d.createActionFromExplicit.execute).mockRejectedValueOnce(new Error("boom"));
    const r = new WireEventRouter(d);
    await r.onTextMessageReceived(makeMessage("action: crash this"));
    expect(d.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("Something went wrong"),
      expect.anything(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Button action handling
// ─────────────────────────────────────────────────────────────────────────────
function makeButtonAction(buttonId: string, referenceMessageId = "msg-1", id = "btn-1") {
  return { id, buttonId, referenceMessageId, conversationId: convId, sender };
}

describe("WireEventRouter contract: button action handling", () => {
  it("unknown button id → warns but does not throw", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onButtonActionReceived(makeButtonAction("unknown_button"));
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Member cache lifecycle
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: member cache lifecycle", () => {
  it("setMembers on app-added", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    const conv = { id: "conv-1", domain: "wire.com" };
    const members = [{ userId: sender, role: "member" }];
    await router.onAppAddedToConversation(conv, members);
    expect(deps.memberCache.setMembers).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conv-1" }),
      expect.any(Array),
    );
  });

  it("addMembers (not setMembers) on user-joined", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    const members = [{ userId: { id: "user-2", domain: "wire.com" }, role: "member" }];
    await router.onUserJoinedConversation(convId, members);
    expect(deps.memberCache.addMembers).toHaveBeenCalledWith(convId, expect.any(Array));
    expect(deps.memberCache.setMembers).not.toHaveBeenCalled();
  });

  it("removeMembers on user-left", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onUserLeftConversation(convId, [sender]);
    expect(deps.memberCache.removeMembers).toHaveBeenCalledWith(convId, [sender]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Pipeline enqueue behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: Phase 2 pipeline enqueue", () => {
  function makeQueueDeps() {
    const enqueueSpy = vi.fn();
    const processSpy = vi.fn().mockResolvedValue(undefined);
    const queue = {
      enqueue: enqueueSpy,
      setWorker: vi.fn(),
      depth: 0,
      concurrency: 0,
    };
    const pipeline = { process: processSpy };
    return { queue, pipeline, enqueueSpy, processSpy };
  }

  it("enqueues a job for every ACTIVE channel message", async () => {
    const { queue, pipeline, enqueueSpy } = makeQueueDeps();
    const deps = makeDeps({
      processingQueue: queue as unknown as WireEventRouterDeps["processingQueue"],
      pipeline: pipeline as unknown as WireEventRouterDeps["pipeline"],
      orgId: "wire.com",
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("hello there"));
    expect(enqueueSpy).toHaveBeenCalledOnce();
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: `${convId.id}@${convId.domain}`,
        payload: expect.objectContaining({ text: "hello there" }),
      }),
    );
  });

  it("does NOT enqueue when pipeline deps are absent", async () => {
    const deps = makeDeps();  // no processingQueue or pipeline
    const router = new WireEventRouter(deps);
    // Just ensure it does not throw
    await expect(router.onTextMessageReceived(makeMessage("hello there"))).resolves.toBeUndefined();
  });

  it("does NOT enqueue when channel is PAUSED (no bot mention)", async () => {
    const { queue, pipeline, enqueueSpy } = makeQueueDeps();
    const deps = makeDeps({
      processingQueue: queue as unknown as WireEventRouterDeps["processingQueue"],
      pipeline: pipeline as unknown as WireEventRouterDeps["pipeline"],
      channelConfig: {
        get: vi.fn().mockResolvedValue({ state: "paused", secureRanges: [], timezone: "UTC", locale: "en", organisationId: "wire.com", channelId: `${convId.id}@${convId.domain}` }),
        upsert: vi.fn(), setState: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("just talking"));
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does NOT enqueue when channel is SECURE", async () => {
    const { queue, pipeline, enqueueSpy } = makeQueueDeps();
    const deps = makeDeps({
      processingQueue: queue as unknown as WireEventRouterDeps["processingQueue"],
      pipeline: pipeline as unknown as WireEventRouterDeps["pipeline"],
      channelConfig: {
        get: vi.fn().mockResolvedValue({ state: "secure", secureRanges: [], timezone: "UTC", locale: "en", organisationId: "wire.com", channelId: `${convId.id}@${convId.domain}` }),
        upsert: vi.fn(), setState: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("confidential stuff"));
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: CatchMeUpCommand routing
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: Phase 4 catch me up routing", () => {
  function makeCatchMeUpCommand() {
    return { execute: vi.fn().mockResolvedValue(undefined) };
  }

  function makeMsg(text: string) {
    return {
      id: "msg-1",
      text,
      conversationId: convId,
      sender: { ...sender },
      mentions: [{ userId: { id: "bot-1", domain: "wire.com" } }],
    };
  }

  it("'@Jeeves catch me up' → catchMeUpCommand.execute", async () => {
    const catchMeUpCommand = makeCatchMeUpCommand();
    const deps = makeDeps({ catchMeUpCommand } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMsg("catch me up"));
    expect(catchMeUpCommand.execute).toHaveBeenCalledOnce();
    expect(catchMeUpCommand.execute).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: `${convId.id}@${convId.domain}` }),
    );
  });

  it("'@Jeeves what did I miss' → catchMeUpCommand.execute", async () => {
    const catchMeUpCommand = makeCatchMeUpCommand();
    const deps = makeDeps({ catchMeUpCommand } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMsg("what did I miss"));
    expect(catchMeUpCommand.execute).toHaveBeenCalledOnce();
  });

  it("'@Jeeves what's new' → catchMeUpCommand.execute", async () => {
    const catchMeUpCommand = makeCatchMeUpCommand();
    const deps = makeDeps({ catchMeUpCommand } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMsg("what's new"));
    expect(catchMeUpCommand.execute).toHaveBeenCalledOnce();
  });

  it("catch me up without catchMeUpCommand dep → falls through to intelligence path", async () => {
    const deps = makeDeps(); // no catchMeUpCommand
    const router = new WireEventRouter(deps);
    // Bot is mentioned so answerQuestion would be called if intelligence path reached
    const msg = makeMsg("catch me up");
    await router.onTextMessageReceived(msg);
    // catchMeUpCommand absent — should not throw, router continues
    expect(deps.wireOutbound.sendPlainText).not.toThrow();
  });
});
