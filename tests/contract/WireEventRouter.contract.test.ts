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
    createTaskFromExplicit: { execute: vi.fn().mockResolvedValue({ id: "TASK-0001" }) },
    updateTaskStatus: { execute: vi.fn().mockResolvedValue(null) },
    listMyTasks: { execute: vi.fn().mockResolvedValue([]) },
    logDecision: { execute: vi.fn().mockResolvedValue({ id: "DEC-0001" }) },
    searchDecisions: { execute: vi.fn().mockResolvedValue(undefined) },
    listDecisions: { execute: vi.fn().mockResolvedValue(undefined) },
    supersedeDecision: { execute: vi.fn().mockResolvedValue(null) },
    revokeDecision: { execute: vi.fn().mockResolvedValue(null) },
    createActionFromExplicit: { execute: vi.fn().mockResolvedValue({ id: "ACT-0001" }) },
    updateActionStatus: { execute: vi.fn().mockResolvedValue(null) },
    listMyActions: { execute: vi.fn().mockResolvedValue([]) },
    listTeamActions: { execute: vi.fn().mockResolvedValue([]) },
    reassignAction: { execute: vi.fn().mockResolvedValue(null) },
    createReminder: { execute: vi.fn().mockResolvedValue({ id: "REM-0001" }) },
    storeKnowledge: { execute: vi.fn().mockResolvedValue({ id: "KB-0001" }) },
    retrieveKnowledge: { execute: vi.fn().mockResolvedValue(undefined) },
    implicitDetection: { detect: vi.fn().mockResolvedValue([]) },
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
    ...overrides,
  } as unknown as WireEventRouterDeps;
}

describe("WireEventRouter contract: explicit command routing", () => {
  let deps: WireEventRouterDeps;
  let router: WireEventRouter;

  beforeEach(() => {
    deps = makeDeps();
    router = new WireEventRouter(deps);
  });

  it("routes 'task: Deploy to prod' → createTaskFromExplicit", async () => {
    await router.onTextMessageReceived(makeMessage("task: Deploy to prod"));
    expect(deps.createTaskFromExplicit.execute).toHaveBeenCalledOnce();
    expect(deps.createTaskFromExplicit.execute).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Deploy to prod" }),
    );
  });

  it("routes 'TASK-0001 done' → updateTaskStatus with status done", async () => {
    await router.onTextMessageReceived(makeMessage("TASK-0001 done"));
    expect(deps.updateTaskStatus.execute).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "TASK-0001", newStatus: "done" }),
    );
  });

  it("routes 'task my tasks' → listMyTasks", async () => {
    await router.onTextMessageReceived(makeMessage("task my tasks"));
    expect(deps.listMyTasks.execute).toHaveBeenCalledOnce();
  });

  it("routes 'decision: Use Postgres' → logDecision", async () => {
    await router.onTextMessageReceived(makeMessage("decision: Use Postgres"));
    expect(deps.logDecision.execute).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Use Postgres" }),
    );
  });

  it("routes 'decisions about auth' → searchDecisions", async () => {
    await router.onTextMessageReceived(makeMessage("decisions about auth"));
    expect(deps.searchDecisions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ searchText: "auth" }),
    );
  });

  it("routes 'list decisions' → listDecisions", async () => {
    await router.onTextMessageReceived(makeMessage("list decisions"));
    expect(deps.listDecisions.execute).toHaveBeenCalledOnce();
  });

  it("routes 'revoke DEC-0001 wrong call' → revokeDecision", async () => {
    await router.onTextMessageReceived(makeMessage("revoke DEC-0001 wrong call"));
    expect(deps.revokeDecision.execute).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: "DEC-0001", reason: "wrong call", actorId: sender }),
    );
  });

  it("routes 'action: Write the spec' → createActionFromExplicit", async () => {
    await router.onTextMessageReceived(makeMessage("action: Write the spec"));
    expect(deps.createActionFromExplicit.execute).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Write the spec" }),
    );
  });

  it("routes 'ACT-0001 done' → updateActionStatus", async () => {
    await router.onTextMessageReceived(makeMessage("ACT-0001 done"));
    expect(deps.updateActionStatus.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "ACT-0001", newStatus: "done" }),
    );
  });

  it("routes 'ACT-0001 reassign to @bob' → reassignAction", async () => {
    await router.onTextMessageReceived(makeMessage("ACT-0001 reassign to @bob"));
    expect(deps.reassignAction.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "ACT-0001", newAssigneeReference: "@bob" }),
    );
  });

  it("routes 'knowledge: API rate limit is 500/min' → storeKnowledge", async () => {
    await router.onTextMessageReceived(makeMessage("knowledge: API rate limit is 500/min"));
    expect(deps.storeKnowledge.execute).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "API rate limit is 500/min" }),
    );
  });

  it("routes 'what is the rate limit?' → retrieveKnowledge", async () => {
    await router.onTextMessageReceived(makeMessage("what is the rate limit?"));
    expect(deps.retrieveKnowledge.execute).toHaveBeenCalledWith(
      expect.objectContaining({ query: "the rate limit" }),
    );
  });

  it("routes unparseable reminder → sends parse error instead of creating reminder", async () => {
    // dateTimeService.parse returns null (default stub), so no reminder should be created
    await router.onTextMessageReceived(makeMessage("remind me to call John"));
    expect(deps.createReminder.execute).not.toHaveBeenCalled();
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("couldn't parse"),
      expect.anything(),
    );
  });

  it("pushes every message to the message buffer", async () => {
    await router.onTextMessageReceived(makeMessage("hello world"));
    expect(deps.messageBuffer.push).toHaveBeenCalledWith(convId, expect.objectContaining({ text: "hello world" }));
  });

  it("sends error reply when a use case throws", async () => {
    vi.mocked(deps.createTaskFromExplicit.execute).mockRejectedValueOnce(new Error("boom"));
    await router.onTextMessageReceived(makeMessage("task: crash this"));
    expect(deps.wireOutbound.sendPlainText).toHaveBeenCalledWith(
      convId,
      expect.stringContaining("Something went wrong"),
      expect.anything(),
    );
  });
});

function makeButtonAction(buttonId: string, referenceMessageId = "msg-1", id = "btn-1") {
  return { id, buttonId, referenceMessageId, conversationId: convId, sender };
}

describe("WireEventRouter contract: button action handling", () => {
  it("confirm_knowledge stores the pending knowledge entry", async () => {
    const deps = makeDeps({
      implicitDetection: {
        detect: vi.fn().mockResolvedValue([
          { type: "knowledge", confidence: 0.9, summary: "Retries are capped at 3", payload: { summary: "Retries are capped at 3", detail: "Retries are capped at 3" } },
        ]),
      },
      conversationConfig: { get: vi.fn().mockResolvedValue({ implicitDetectionEnabled: true, sensitivity: "normal" }), upsert: vi.fn() },
    });
    const router = new WireEventRouter(deps);

    // Trigger implicit detection to register a pending entry
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
      implicitDetection: {
        detect: vi.fn().mockResolvedValue([
          { type: "knowledge", confidence: 0.9, summary: "Retries capped", payload: {} },
        ]),
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
