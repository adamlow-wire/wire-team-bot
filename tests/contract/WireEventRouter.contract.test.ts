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
    // Tasks
    createTaskFromExplicit: { execute: vi.fn().mockResolvedValue({ id: "TASK-0001" }) },
    updateTaskStatus: { execute: vi.fn().mockResolvedValue(null) },
    updateTask: { execute: vi.fn().mockResolvedValue(null) },
    reassignTask: { execute: vi.fn().mockResolvedValue(null) },
    updateTaskDeadline: { execute: vi.fn().mockResolvedValue(null) },
    listMyTasks: { execute: vi.fn().mockResolvedValue([]) },
    listTeamTasks: { execute: vi.fn().mockResolvedValue([]) },
    // Decisions
    logDecision: { execute: vi.fn().mockResolvedValue({ id: "DEC-0001" }) },
    searchDecisions: { execute: vi.fn().mockResolvedValue(undefined) },
    listDecisions: { execute: vi.fn().mockResolvedValue(undefined) },
    supersedeDecision: { execute: vi.fn().mockResolvedValue(null) },
    revokeDecision: { execute: vi.fn().mockResolvedValue(null) },
    // Actions
    createActionFromExplicit: { execute: vi.fn().mockResolvedValue({ id: "ACT-0001" }) },
    updateActionStatus: { execute: vi.fn().mockResolvedValue(null) },
    updateAction: { execute: vi.fn().mockResolvedValue(null) },
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
    // Knowledge
    storeKnowledge: { execute: vi.fn().mockResolvedValue({ id: "KB-0001" }) },
    retrieveKnowledge: { execute: vi.fn().mockResolvedValue(undefined) },
    deleteKnowledge: { execute: vi.fn().mockResolvedValue(null) },
    updateKnowledge: { execute: vi.fn().mockResolvedValue(null) },
    // General
    answerQuestion: { execute: vi.fn().mockResolvedValue(undefined) },
    // Intelligence (default: no intent, bot stays silent)
    conversationIntelligence: {
      analyze: vi.fn().mockResolvedValue({ intent: "none", payload: {}, confidence: 0, shouldRespond: false }),
    },
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

  it("'TASK-0001 done' → updateTaskStatus with status done", async () => {
    await router.onTextMessageReceived(makeMessage("TASK-0001 done"));
    expect(deps.updateTaskStatus.execute).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "TASK-0001", newStatus: "done" }),
    );
  });

  it("'close TASK-0001' → updateTaskStatus with status done", async () => {
    await router.onTextMessageReceived(makeMessage("close TASK-0001"));
    expect(deps.updateTaskStatus.execute).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "TASK-0001", newStatus: "done" }),
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

  it("'TASK-0001 reassign to alice' → reassignTask", async () => {
    await router.onTextMessageReceived(makeMessage("TASK-0001 reassign to alice"));
    expect(deps.reassignTask.execute).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "TASK-0001", newAssigneeReference: "alice" }),
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

  it("'forget KB-0001' → deleteKnowledge fast-path", async () => {
    await router.onTextMessageReceived(makeMessage("forget KB-0001"));
    expect(deps.deleteKnowledge.execute).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeId: "KB-0001" }),
    );
  });

  it("'update KB-0001 new text' → updateKnowledge fast-path", async () => {
    await router.onTextMessageReceived(makeMessage("update KB-0001 new text"));
    expect(deps.updateKnowledge.execute).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeId: "KB-0001", newSummary: "new text" }),
    );
  });

  it("'list decisions' exact-match → listDecisions", async () => {
    await router.onTextMessageReceived(makeMessage("list decisions"));
    expect(deps.listDecisions.execute).toHaveBeenCalledOnce();
  });

  it("'my tasks' exact-match → listMyTasks", async () => {
    await router.onTextMessageReceived(makeMessage("my tasks"));
    expect(deps.listMyTasks.execute).toHaveBeenCalledOnce();
  });

  it("'team tasks' exact-match → listTeamTasks", async () => {
    await router.onTextMessageReceived(makeMessage("team tasks"));
    expect(deps.listTeamTasks.execute).toHaveBeenCalledOnce();
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
// Intelligence-path routing (LLM mock provides intent)
// ─────────────────────────────────────────────────────────────────────────────
describe("WireEventRouter contract: intelligence-path routing", () => {
  it("create_task intent → createTaskFromExplicit", async () => {
    const deps = makeDeps({
      conversationIntelligence: {
        analyze: vi.fn().mockResolvedValue({ intent: "create_task", confidence: 0.9, shouldRespond: true, payload: { description: "Deploy to prod" } }),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("task: Deploy to prod"));
    expect(deps.createTaskFromExplicit.execute).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Deploy to prod" }),
    );
  });

  it("create_decision intent → logDecision", async () => {
    const deps = makeDeps({
      conversationIntelligence: {
        analyze: vi.fn().mockResolvedValue({ intent: "create_decision", confidence: 0.9, shouldRespond: true, payload: { summary: "Use Postgres" } }),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("decision: Use Postgres"));
    expect(deps.logDecision.execute).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Use Postgres" }),
    );
  });

  it("list_decisions intent with query → searchDecisions", async () => {
    const deps = makeDeps({
      conversationIntelligence: {
        analyze: vi.fn().mockResolvedValue({ intent: "list_decisions", confidence: 0.9, shouldRespond: true, payload: { query: "auth" } }),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("decisions about auth"));
    expect(deps.searchDecisions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ searchText: "auth" }),
    );
  });

  it("create_action intent → createActionFromExplicit", async () => {
    const deps = makeDeps({
      conversationIntelligence: {
        analyze: vi.fn().mockResolvedValue({ intent: "create_action", confidence: 0.9, shouldRespond: true, payload: { description: "Write the spec" } }),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("action: Write the spec"));
    expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Write the spec" }),
    );
  });

  it("store_knowledge intent → storeKnowledge", async () => {
    const deps = makeDeps({
      conversationIntelligence: {
        analyze: vi.fn().mockResolvedValue({ intent: "store_knowledge", confidence: 0.9, shouldRespond: true, payload: { summary: "API rate limit is 500/min", detail: "API rate limit is 500/min" } }),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("knowledge: API rate limit is 500/min"));
    expect(deps.storeKnowledge.execute).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "API rate limit is 500/min" }),
    );
  });

  it("retrieve_knowledge intent → answerQuestion (unified RAG path)", async () => {
    const deps = makeDeps({
      conversationIntelligence: {
        analyze: vi.fn().mockResolvedValue({ intent: "retrieve_knowledge", confidence: 0.9, shouldRespond: true, payload: { query: "the rate limit" } }),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("what is the rate limit?"));
    expect(deps.answerQuestion.execute).toHaveBeenCalledWith(
      expect.objectContaining({ question: "the rate limit" }),
    );
  });

  it("create_reminder with parseable time → createReminder", async () => {
    const parsedDate = new Date("2026-03-16T15:00:00Z");
    const deps = makeDeps({
      conversationIntelligence: {
        analyze: vi.fn().mockResolvedValue({ intent: "create_reminder", confidence: 0.9, shouldRespond: true, payload: { timeExpression: "3pm", description: "call John" } }),
      },
      dateTimeService: { parse: vi.fn().mockReturnValue({ value: parsedDate }) },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("remind me at 3pm to call John"));
    expect(deps.createReminder.execute).toHaveBeenCalledWith(
      expect.objectContaining({ description: "call John", triggerAt: parsedDate }),
    );
  });

  it("create_reminder with unparseable time → sends error, no reminder created", async () => {
    const deps = makeDeps({
      conversationIntelligence: {
        analyze: vi.fn().mockResolvedValue({ intent: "create_reminder", confidence: 0.9, shouldRespond: true, payload: { timeExpression: "someday", description: "call John" } }),
      },
    });
    const router = new WireEventRouter(deps);
    await router.onTextMessageReceived(makeMessage("remind me to call John"));
    expect(deps.createReminder.execute).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("couldn't parse"),
      expect.anything(),
    );
  });

  it("shouldRespond:false + intent:none → bot stays silent", async () => {
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
    const d = makeDeps({
      conversationIntelligence: {
        analyze: vi.fn().mockResolvedValue({ intent: "create_task", confidence: 0.9, shouldRespond: true, payload: { description: "crash this" } }),
      },
    });
    vi.mocked(d.createTaskFromExplicit.execute).mockRejectedValueOnce(new Error("boom"));
    const r = new WireEventRouter(d);
    await r.onTextMessageReceived(makeMessage("task: crash this"));
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
  it("confirm_knowledge stores the pending knowledge entry", async () => {
    const deps = makeDeps({
      conversationIntelligence: {
        analyze: vi.fn().mockResolvedValue({
          intent: "none", confidence: 0, shouldRespond: false,
          payload: {},
          capture: { type: "knowledge", confidence: 0.9, summary: "Retries are capped at 3", detail: "Retries are capped at 3", payload: {} },
        }),
      },
      conversationConfig: { get: vi.fn().mockResolvedValue({ implicitDetectionEnabled: true, sensitivity: "normal" }), upsert: vi.fn() },
    });
    const router = new WireEventRouter(deps);

    // Trigger capture to register a pending entry
    await router.onTextMessageReceived(makeMessage("we decided retries are capped at 3"));
    expect(deps.wireOutbound.sendCompositePrompt).toHaveBeenCalled();

    // Confirm the candidate
    await router.onButtonActionReceived(makeButtonAction("confirm_knowledge"));
    expect(deps.storeKnowledge.execute).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Retries are capped at 3" }),
    );
  });

  it("dismiss clears the pending knowledge entry without storing", async () => {
    const deps = makeDeps({
      conversationIntelligence: {
        analyze: vi.fn().mockResolvedValue({
          intent: "none", confidence: 0, shouldRespond: false,
          payload: {},
          capture: { type: "knowledge", confidence: 0.9, summary: "Retries capped", detail: "Retries capped", payload: {} },
        }),
      },
      conversationConfig: { get: vi.fn().mockResolvedValue({ implicitDetectionEnabled: true, sensitivity: "normal" }), upsert: vi.fn() },
    });
    const router = new WireEventRouter(deps);

    await router.onTextMessageReceived(makeMessage("retries capped"));
    await router.onButtonActionReceived(makeButtonAction("dismiss"));

    expect(deps.storeKnowledge.execute).not.toHaveBeenCalled();
  });

  it("'yes' button sends guidance message", async () => {
    const deps = makeDeps();
    const router = new WireEventRouter(deps);
    await router.onButtonActionReceived(makeButtonAction("yes"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("action:"),
    );
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
