/**
 * Contract tests for WireEventRouter — Phase 3.
 *
 * All explicit regex command handlers have been replaced by the NL intent
 * classifier.  These tests verify:
 *   1. State machine (pause / resume / secure) still works exactly.
 *   2. Bot-addressed messages → intentClassifier → intentExecutor.
 *   3. Unknown intent falls through to answerQuestion.
 *   4. Non-addressed messages → pipeline enqueue (not addressed messages are skipped).
 *   5. Button action handling via PendingActionStore.
 *   6. Member cache lifecycle events.
 *   7. CatchMeUpCommand routing (Phase 4 compat).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WireEventRouter } from "../../src/infrastructure/wire/WireEventRouter";
import type { WireEventRouterDeps } from "../../src/infrastructure/wire/WireEventRouter";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const sender: QualifiedId = { id: "user-1", domain: "wire.com" };
const botId: QualifiedId = { id: "bot-1", domain: "wire.com" };

function makeMessage(text: string, id = "msg-1", mentions: Array<{ userId: QualifiedId }> = []) {
  return { id, text, conversationId: convId, sender, mentions };
}

function makeBotMessage(text: string, id = "msg-1") {
  return makeMessage(text, id, [{ userId: botId }]);
}

function makeDeps(overrides: Partial<WireEventRouterDeps> = {}): WireEventRouterDeps {
  return {
    logger: { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logDecision: { execute: vi.fn().mockResolvedValue({ id: "DEC-0001" }) },
    searchDecisions: { execute: vi.fn().mockResolvedValue(undefined) },
    listDecisions: { execute: vi.fn().mockResolvedValue(undefined) },
    supersedeDecision: { execute: vi.fn().mockResolvedValue(null) },
    revokeDecision: { execute: vi.fn().mockResolvedValue(null) },
    createActionFromExplicit: { execute: vi.fn().mockResolvedValue({ id: "ACT-0001" }) },
    updateActionStatus: { execute: vi.fn().mockResolvedValue(null) },
    reassignAction: { execute: vi.fn().mockResolvedValue(null) },
    updateActionDeadline: { execute: vi.fn().mockResolvedValue(null) },
    listMyActions: { execute: vi.fn().mockResolvedValue([]) },
    listTeamActions: { execute: vi.fn().mockResolvedValue([]) },
    listOverdueActions: { execute: vi.fn().mockResolvedValue([]) },
    createReminder: { execute: vi.fn().mockResolvedValue({ id: "REM-0001" }) },
    listMyReminders: { execute: vi.fn().mockResolvedValue([]) },
    cancelReminder: { execute: vi.fn().mockResolvedValue(null) },
    snoozeReminder: { execute: vi.fn().mockResolvedValue(null) },
    answerQuestion: { execute: vi.fn().mockResolvedValue("Here is the answer.") },
    botUserId: botId,
    wireOutbound: {
      sendPlainText: vi.fn().mockResolvedValue(undefined),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      getUserProfile: vi.fn().mockResolvedValue(null),
    },
    messageBuffer: { push: vi.fn(), getLastN: vi.fn().mockReturnValue([]) },
    dateTimeService: { parse: vi.fn().mockReturnValue(null) },
    memberCache: {
      setMembers: vi.fn(), addMembers: vi.fn(), getMembers: vi.fn().mockReturnValue([]),
      removeMembers: vi.fn(), clearConversation: vi.fn(), updateMemberName: vi.fn(),
    },
    conversationConfig: { get: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    channelConfig: {
      get: vi.fn().mockResolvedValue(null), upsert: vi.fn(), setState: vi.fn(),
      openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]),
    },
    slidingWindow: { push: vi.fn(), getWindow: vi.fn().mockReturnValue([]), flush: vi.fn(), clear: vi.fn() },
    scheduler: { schedule: vi.fn(), cancel: vi.fn(), setHandler: vi.fn() },
    secretModeInactivityMs: 600_000,
    ...overrides,
  } as unknown as WireEventRouterDeps;
}

// ─────────────────────────────────────────────────────────────────────────────
// State machine — still exact-match, no classifier needed
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: state machine", () => {
  it("@mention + 'pause' → channel paused", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeBotMessage("pause"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("step out"),
      expect.anything(),
    );
  });

  it("@mention + 'resume' on active channel → 'already at your service'", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeBotMessage("resume"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("at your service"),
      expect.anything(),
    );
  });

  it("@mention + 'secure mode' → channel secured", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeBotMessage("secure mode"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("cleared"),
      expect.anything(),
    );
  });

  it("non-addressed message on PAUSED channel → discarded silently", async () => {
    const deps = makeDeps({
      channelConfig: {
        get: vi.fn().mockResolvedValue({ state: "paused", secureRanges: [], timezone: "UTC", locale: "en", organisationId: "wire.com", channelId: `${convId.id}@${convId.domain}` }),
        upsert: vi.fn(), setState: vi.fn(), openSecureRange: vi.fn(), closeSecureRange: vi.fn(), listByState: vi.fn().mockResolvedValue([]),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("just talking"));
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Intent classifier routing (Phase 3 NL path)
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: intent classifier routing", () => {
  function makeClassifierDeps(intentType: string, execHandled = true) {
    const classifier = { classify: vi.fn().mockResolvedValue({ type: intentType, params: {} }) };
    const executor = { execute: vi.fn().mockResolvedValue(execHandled) };
    return { classifier, executor, deps: makeDeps({ intentClassifier: classifier, intentExecutor: executor } as Partial<WireEventRouterDeps>) };
  }

  it("@mention with recognized intent → classifier called with stripped text", async () => {
    const { classifier, executor, deps } = makeClassifierDeps("list_my_actions");
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeBotMessage("show me my actions please"));
    expect(classifier.classify).toHaveBeenCalledWith("show me my actions please", expect.any(Array));
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ type: "list_my_actions" }),
      expect.objectContaining({ conversationId: convId, sender }),
    );
  });

  it("@mention with recognized intent that is handled → does not call answerQuestion", async () => {
    const { deps } = makeClassifierDeps("list_my_actions", true);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeBotMessage("show me my actions please"));
    expect(deps.answerQuestion.execute).not.toHaveBeenCalled();
  });

  it("@mention with 'unknown' intent → falls through to answerQuestion", async () => {
    const { deps } = makeClassifierDeps("unknown", false);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeBotMessage("what's the weather like?"));
    expect(deps.answerQuestion.execute).toHaveBeenCalled();
  });

  it("@mention without intentClassifier → goes directly to answerQuestion", async () => {
    const deps = makeDeps(); // no intentClassifier or intentExecutor
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeBotMessage("what did we decide about auth?"));
    expect(deps.answerQuestion.execute).toHaveBeenCalled();
  });

  it("non-addressed message → classifier NOT called", async () => {
    const classifier = { classify: vi.fn().mockResolvedValue({ type: "list_my_actions", params: {} }) };
    const executor = { execute: vi.fn().mockResolvedValue(true) };
    const deps = makeDeps({ intentClassifier: classifier, intentExecutor: executor } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("show me my actions"));
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("state-change commands are handled before classifier (classifier not called for 'pause')", async () => {
    const classifier = { classify: vi.fn().mockResolvedValue({ type: "unknown", params: {} }) };
    const executor = { execute: vi.fn().mockResolvedValue(false) };
    const deps = makeDeps({ intentClassifier: classifier, intentExecutor: executor } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeBotMessage("pause"));
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// General behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: general behaviour", () => {
  it("pushes every message to the message buffer", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("hello world"));
    expect(deps.messageBuffer.push).toHaveBeenCalledWith(convId, expect.objectContaining({ text: "hello world" }));
  });

  it("non-command message without bot mention → bot stays silent", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("yes its set up for tomorrow"));
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendCompositePrompt).not.toHaveBeenCalled();
  });

  it("sends error reply when handler throws", async () => {
    const classifier = { classify: vi.fn().mockRejectedValue(new Error("boom")) };
    const executor = { execute: vi.fn().mockResolvedValue(false) };
    const deps = makeDeps({ intentClassifier: classifier, intentExecutor: executor } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeBotMessage("do something"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("Something went wrong"),
      expect.anything(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline enqueue behaviour (Phase 3 update: @mentioned messages NOT enqueued)
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: pipeline enqueue", () => {
  function makeQueueDeps() {
    const enqueueSpy = vi.fn();
    const queue = { enqueue: enqueueSpy, setWorker: vi.fn(), depth: 0, concurrency: 0 };
    const pipeline = { process: vi.fn().mockResolvedValue(undefined) };
    return { queue, pipeline, enqueueSpy };
  }

  it("enqueues a job for non-addressed ACTIVE channel messages", async () => {
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

  it("does NOT enqueue when bot is @mentioned (handled synchronously)", async () => {
    const { queue, pipeline, enqueueSpy } = makeQueueDeps();
    const classifier = { classify: vi.fn().mockResolvedValue({ type: "list_my_actions", params: {} }) };
    const executor = { execute: vi.fn().mockResolvedValue(true) };
    const deps = makeDeps({
      processingQueue: queue as unknown as WireEventRouterDeps["processingQueue"],
      pipeline: pipeline as unknown as WireEventRouterDeps["pipeline"],
      intentClassifier: classifier,
      intentExecutor: executor,
    } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeBotMessage("show my actions"));
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does NOT enqueue when pipeline deps are absent", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await expect(router.onTextMessageReceived(makeMessage("hello there"))).resolves.toBeUndefined();
  });

  it("does NOT enqueue when channel is PAUSED", async () => {
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
// Button action handling (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────
function makeButtonAction(buttonId: string, referenceMessageId = "msg-1") {
  return { id: "btn-1", buttonId, referenceMessageId, conversationId: convId, sender };
}

describe("WireEventRouter contract: button action handling", () => {
  it("button with no pendingActionStore → no outbound message, no throw", async () => {
    const deps = makeDeps(); // no pendingActionStore
    const router = new WireEventRouter(deps);
    await expect(router.onButtonActionReceived(makeButtonAction("jeeves:undo:decision:DEC-42"))).resolves.toBeUndefined();
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });

  it("undo_decision button → fetches decision, soft-deletes, sends confirmation", async () => {
    const decision = { id: "DEC-42", summary: "use postgres", status: "active", deleted: false, conversationId: convId, timestamp: new Date(), updatedAt: new Date(), version: 1 };
    const pendingActionStore = {
      get: vi.fn().mockResolvedValue({ kind: "undo_decision", channelId: "conv-1@wire.com", entityId: "DEC-42", entityType: "decision" }),
      del: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const decisionRepo = {
      findById: vi.fn().mockResolvedValue(decision),
      update: vi.fn().mockResolvedValue({ ...decision, deleted: true }),
      create: vi.fn(), query: vi.fn(), nextId: vi.fn(), findByContentHash: vi.fn(),
    };
    const deps = makeDeps({
      pendingActionStore: pendingActionStore as unknown as WireEventRouterDeps["pendingActionStore"],
      decisionRepo: decisionRepo as unknown as WireEventRouterDeps["decisionRepo"],
    });
    const router = new WireEventRouter(deps);
    await router.onButtonActionReceived(makeButtonAction("jeeves:undo:decision:DEC-42"));
    expect(decisionRepo.update).toHaveBeenCalledWith(expect.objectContaining({ deleted: true }));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("DEC-42"),
    );
  });

  it("dismiss button → no repo mutation, no confirmation message", async () => {
    const pendingActionStore = {
      get: vi.fn().mockResolvedValue({ kind: "dismiss", channelId: "conv-1@wire.com", entityId: "DEC-42", entityType: "decision" }),
      del: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const deps = makeDeps({
      pendingActionStore: pendingActionStore as unknown as WireEventRouterDeps["pendingActionStore"],
    });
    const router = new WireEventRouter(deps);
    await router.onButtonActionReceived(makeButtonAction("jeeves:dismiss:decision:DEC-42"));
    expect(deps.wireOutbound.sendPlainText).not.toHaveBeenCalled();
  });

  it("expired button (store returns null) → silent no-op", async () => {
    const pendingActionStore = {
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const deps = makeDeps({
      pendingActionStore: pendingActionStore as unknown as WireEventRouterDeps["pendingActionStore"],
    });
    const router = new WireEventRouter(deps);
    await router.onButtonActionReceived(makeButtonAction("jeeves:undo:decision:DEC-99"));
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
// CatchMeUpCommand routing (Phase 4 compat)
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: catch me up routing", () => {
  function makeMsg(text: string) {
    return { id: "msg-1", text, conversationId: convId, sender, mentions: [{ userId: botId }] };
  }

  it("'@Jeeves catch me up' → catchMeUpCommand.execute", async () => {
    const catchMeUpCommand = { execute: vi.fn().mockResolvedValue(undefined) };
    const deps = makeDeps({ catchMeUpCommand } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMsg("catch me up"));
    expect(catchMeUpCommand.execute).toHaveBeenCalledOnce();
    expect(catchMeUpCommand.execute).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: `${convId.id}@${convId.domain}` }),
    );
  });

  it("'@Jeeves what did I miss' → catchMeUpCommand.execute", async () => {
    const catchMeUpCommand = { execute: vi.fn().mockResolvedValue(undefined) };
    const deps = makeDeps({ catchMeUpCommand } as Partial<WireEventRouterDeps>);
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMsg("what did I miss"));
    expect(catchMeUpCommand.execute).toHaveBeenCalledOnce();
  });
});
