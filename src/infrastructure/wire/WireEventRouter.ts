import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { Conversation, ConversationMember, TextMessage, ButtonActionMessage } from "wire-apps-js-sdk";
import { WireEventsHandler, ButtonActionConfirmationMessage } from "wire-apps-js-sdk";
import type { CreateTaskFromExplicit } from "../../application/usecases/tasks/CreateTaskFromExplicit";
import type { UpdateTaskStatus } from "../../application/usecases/tasks/UpdateTaskStatus";
import type { ListMyTasks } from "../../application/usecases/tasks/ListMyTasks";
import type { UpdateTask } from "../../application/usecases/tasks/UpdateTask";
import type { ReassignTask } from "../../application/usecases/tasks/ReassignTask";
import type { UpdateTaskDeadline } from "../../application/usecases/tasks/UpdateTaskDeadline";
import type { ListTeamTasks } from "../../application/usecases/tasks/ListTeamTasks";
import type { LogDecision } from "../../application/usecases/decisions/LogDecision";
import type { CreateActionFromExplicit } from "../../application/usecases/actions/CreateActionFromExplicit";
import type { UpdateActionStatus } from "../../application/usecases/actions/UpdateActionStatus";
import type { ListMyActions } from "../../application/usecases/actions/ListMyActions";
import type { ListTeamActions } from "../../application/usecases/actions/ListTeamActions";
import type { ReassignAction } from "../../application/usecases/actions/ReassignAction";
import type { UpdateAction } from "../../application/usecases/actions/UpdateAction";
import type { UpdateActionDeadline } from "../../application/usecases/actions/UpdateActionDeadline";
import type { ListOverdueActions } from "../../application/usecases/actions/ListOverdueActions";
import type { SearchDecisions } from "../../application/usecases/decisions/SearchDecisions";
import type { ListDecisions } from "../../application/usecases/decisions/ListDecisions";
import type { SupersedeDecision } from "../../application/usecases/decisions/SupersedeDecision";
import type { RevokeDecision } from "../../application/usecases/decisions/RevokeDecision";
import type { CreateReminder } from "../../application/usecases/reminders/CreateReminder";
import type { ListMyReminders } from "../../application/usecases/reminders/ListMyReminders";
import type { CancelReminder } from "../../application/usecases/reminders/CancelReminder";
import type { SnoozeReminder } from "../../application/usecases/reminders/SnoozeReminder";
import type { StoreKnowledge } from "../../application/usecases/knowledge/StoreKnowledge";
import type { RetrieveKnowledge } from "../../application/usecases/knowledge/RetrieveKnowledge";
import type { DeleteKnowledge } from "../../application/usecases/knowledge/DeleteKnowledge";
import type { UpdateKnowledge } from "../../application/usecases/knowledge/UpdateKnowledge";
import type { AnswerQuestion } from "../../application/usecases/general/AnswerQuestion";
import type { ConversationMessageBuffer } from "../../application/services/ConversationMessageBuffer";
import type { DateTimeService } from "../../domain/services/DateTimeService";
import type { ConversationMemberCache, CachedMember } from "../../domain/services/ConversationMemberCache";
import type { ConversationConfigRepository } from "../../domain/repositories/ConversationConfigRepository";
import type { ConversationIntelligenceService, ConversationIntelligenceResult } from "../../domain/services/ConversationIntelligenceService";
import type { WireOutboundPort } from "../../application/ports/WireOutboundPort";
import type { SchedulerPort } from "../../application/ports/SchedulerPort";
import type { Logger } from "../../application/ports/Logger";
import type { TaskPriority, TaskStatus } from "../../domain/entities/Task";
import type { ActionStatus } from "../../domain/entities/Action";

const CONTEXT_WINDOW = 10;
const IMPLICIT_KNOWLEDGE_MIN_CONFIDENCE = 0.7;
const INTENT_CONFIDENCE_THRESHOLD = 0.75;

const HELP_TEXT = `**Here's what I can do:**

**Tasks** — _"task: write the spec"_ or _"we need to write the migration doc"_
  Update: \`TASK-0001 done\` | \`cancelled\` | \`in_progress\`
  Reassign: _"TASK-0001 reassign to Mark"_
  Deadline: _"TASK-0001 due Friday"_
  List mine: _"my tasks"_ | List team: _"team tasks"_

**Decisions** — _"decision: we're going with Postgres"_ or _"we've decided to use option A"_
  List/search: _"list decisions"_ | _"decisions about pricing"_
  Revoke: \`revoke DEC-0001\`

**Actions** — _"action: John to follow up on contract"_ or _"John should call Schwarz"_
  Update: \`ACT-0001 done\` | \`cancelled\`
  Reassign: _"assign ACT-0001 to Mark"_
  Deadline: _"ACT-0001 due Friday"_
  List mine: _"my actions"_ | Team: _"team actions"_ | Overdue: _"overdue actions"_

**Reminders** — _"remind me at 3pm to call John"_ | _"reminder in 2 hours check the build"_
  List: _"show reminders"_ | Cancel: _"cancel REM-0001"_ | Snooze: _"snooze REM-0001 1 hour"_

**Knowledge** — _"remember that Schwarz have 10k users"_ | say a fact then _"remember this"_
  Retrieve: _"what is our rate limit?"_ | _"how do we handle auth?"_
  Update: _"update KB-0001 new summary text"_ | Forget: _"forget KB-0001"_

I also detect things worth recording automatically from your conversation.

Type _"secret mode"_ to pause me. Type _"resume"_ to start listening again.`;

function toCachedMembers(members: ConversationMember[]): CachedMember[] {
  return members.map((m) => ({
    userId: m.userId as QualifiedId,
    role: (m.role === "wire_admin" ? "admin" : "member") as CachedMember["role"],
  }));
}

export interface WireEventRouterDeps {
  logger: Logger;
  // Tasks
  createTaskFromExplicit: CreateTaskFromExplicit;
  updateTaskStatus: UpdateTaskStatus;
  updateTask: UpdateTask;
  reassignTask: ReassignTask;
  updateTaskDeadline: UpdateTaskDeadline;
  listMyTasks: ListMyTasks;
  listTeamTasks: ListTeamTasks;
  // Decisions
  logDecision: LogDecision;
  searchDecisions: SearchDecisions;
  listDecisions: ListDecisions;
  supersedeDecision: SupersedeDecision;
  revokeDecision: RevokeDecision;
  // Actions
  createActionFromExplicit: CreateActionFromExplicit;
  updateActionStatus: UpdateActionStatus;
  updateAction: UpdateAction;
  reassignAction: ReassignAction;
  updateActionDeadline: UpdateActionDeadline;
  listMyActions: ListMyActions;
  listTeamActions: ListTeamActions;
  listOverdueActions: ListOverdueActions;
  // Reminders
  createReminder: CreateReminder;
  listMyReminders: ListMyReminders;
  cancelReminder: CancelReminder;
  snoozeReminder: SnoozeReminder;
  // Knowledge
  storeKnowledge: StoreKnowledge;
  retrieveKnowledge: RetrieveKnowledge;
  deleteKnowledge: DeleteKnowledge;
  updateKnowledge: UpdateKnowledge;
  // General
  answerQuestion: AnswerQuestion;
  // Infrastructure
  botUserId: QualifiedId;
  conversationIntelligence: ConversationIntelligenceService;
  wireOutbound: WireOutboundPort;
  messageBuffer: ConversationMessageBuffer;
  dateTimeService: DateTimeService;
  memberCache: ConversationMemberCache;
  conversationConfig: ConversationConfigRepository;
  scheduler: SchedulerPort;
  secretModeInactivityMs: number;
}

interface PendingKnowledgeConfirmation {
  summary: string;
  detail: string;
  authorId: QualifiedId;
  rawMessageId: string;
  rawMessage: string;
}

export class WireEventRouter extends WireEventsHandler {
  private readonly pendingKnowledge = new Map<string, PendingKnowledgeConfirmation>();
  private readonly secretModeConvs = new Set<string>();
  private readonly lastActivityByConv = new Map<string, number>();
  private readonly knownConvs = new Set<string>();
  private readonly actionedMessageIds = new Map<string, Set<string>>();

  constructor(private readonly deps: WireEventRouterDeps) {
    super();
  }

  async onTextMessageReceived(wireMessage: TextMessage): Promise<void> {
    const text = wireMessage.text ?? "";
    const convId = wireMessage.conversationId as QualifiedId;
    const sender = wireMessage.sender as QualifiedId;
    const convKey = `${convId.id}@${convId.domain}`;
    const log = this.deps.logger.child({
      conversationId: convId.id,
      senderId: sender.id,
      messageId: wireMessage.id,
    });

    this.deps.messageBuffer.push(convId, {
      messageId: wireMessage.id,
      senderId: sender,
      senderName: "",
      text,
      timestamp: new Date(),
    });
    this.lastActivityByConv.set(convKey, Date.now());

    if (!this.knownConvs.has(convKey)) {
      this.knownConvs.add(convKey);
      const config = await this.deps.conversationConfig.get(convId);
      if (config?.secretMode) {
        this.secretModeConvs.add(convKey);
        this.scheduleInactivityCheck(convId, convKey);
        log.info("Secret mode restored from DB");
      }
    }

    try {
      await this.handleTextMessage(wireMessage, text, convId, sender, convKey, log);
    } catch (err) {
      log.error("Handler failed", { err: String(err), stack: err instanceof Error ? err.stack : undefined });
      try {
        await this.deps.wireOutbound.sendPlainText(convId, "Something went wrong. Please try again.", {
          replyToMessageId: wireMessage.id,
        });
      } catch (sendErr) {
        log.error("Failed to send error reply", { err: String(sendErr) });
      }
    }
  }

  private async handleTextMessage(
    wireMessage: TextMessage,
    text: string,
    convId: QualifiedId,
    sender: QualifiedId,
    convKey: string,
    log: Logger,
  ): Promise<void> {
    const lowered = text.trim().toLowerCase();

    // ── Secret mode ───────────────────────────────────────────────────────────
    if (this.secretModeConvs.has(convKey)) {
      this.scheduleInactivityCheck(convId, convKey);
      const result = await this.deps.conversationIntelligence.analyze({
        currentMessage: text, currentMessageId: wireMessage.id,
        recentMessages: [], sensitivity: "normal", conversationId: convId,
      });
      if (result.intent === "secret_mode_off" && result.confidence >= INTENT_CONFIDENCE_THRESHOLD) {
        await this.exitSecretMode(convId, convKey, wireMessage.id, log);
      } else {
        log.debug("Secret mode active — message dropped");
      }
      return;
    }

    // ── Fast-path: ID-based mutations (no LLM needed) ─────────────────────────

    // cancel REM-NNNN
    const cancelReminderMatch = text.match(/^cancel\s+(REM-\d+)\s*$/i);
    if (cancelReminderMatch) {
      log.debug("Fast-path: cancel reminder", { reminderId: cancelReminderMatch[1] });
      await this.deps.cancelReminder.execute({
        reminderId: cancelReminderMatch[1], conversationId: convId, actorId: sender, replyToMessageId: wireMessage.id,
      });
      return;
    }

    // snooze REM-NNNN <expression>
    const snoozeReminderMatch = text.match(/^snooze\s+(REM-\d+)\s+(.+)$/i);
    if (snoozeReminderMatch) {
      log.debug("Fast-path: snooze reminder", { reminderId: snoozeReminderMatch[1] });
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.snoozeReminder.execute({
        reminderId: snoozeReminderMatch[1], conversationId: convId, actorId: sender,
        snoozeExpression: snoozeReminderMatch[2].trim(),
        timezone: config?.timezone ?? "UTC",
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    // forget KB-NNNN
    const forgetKbMatch = text.match(/^forget\s+(KB-\d+)\s*$/i);
    if (forgetKbMatch) {
      log.debug("Fast-path: delete knowledge", { knowledgeId: forgetKbMatch[1] });
      await this.deps.deleteKnowledge.execute({
        knowledgeId: forgetKbMatch[1], conversationId: convId, actorId: sender, replyToMessageId: wireMessage.id,
      });
      return;
    }

    // update KB-NNNN <new summary>
    const updateKbMatch = text.match(/^update\s+(KB-\d+)\s+(.+)$/i);
    if (updateKbMatch) {
      log.debug("Fast-path: update knowledge", { knowledgeId: updateKbMatch[1] });
      await this.deps.updateKnowledge.execute({
        knowledgeId: updateKbMatch[1], conversationId: convId, actorId: sender,
        newSummary: updateKbMatch[2].trim(), replyToMessageId: wireMessage.id,
      });
      return;
    }

    // TASK-NNNN status or status TASK-NNNN
    const taskDoneMatch = text.match(/^(?:(TASK-\d+)\s+(done|in[_\s]progress|cancelled|close|complete|cancel)|(done|close|complete|cancel|cancelled|in[_\s]progress)\s+(TASK-\d+))\s*(.*)$/i);
    if (taskDoneMatch) {
      const taskId = (taskDoneMatch[1] ?? taskDoneMatch[4])!;
      const rawStatus = (taskDoneMatch[2] ?? taskDoneMatch[3])!.toLowerCase();
      const note = taskDoneMatch[5]?.trim() || undefined;
      const norm = rawStatus === "close" || rawStatus === "complete" ? "done"
        : rawStatus === "cancel" ? "cancelled"
        : rawStatus.replace(/\s/, "_") as TaskStatus;
      log.debug("Fast-path: task status update", { taskId, newStatus: norm });
      await this.deps.updateTaskStatus.execute({
        taskId, newStatus: norm, conversationId: convId, actorId: sender,
        completionNote: note, replyToMessageId: wireMessage.id,
      });
      return;
    }

    // TASK-NNNN reassign to <name> or reassign TASK-NNNN to <name>
    const taskReassignMatch = text.match(/^(?:(TASK-\d+)\s+reassign\s+to\s+(.+)|(?:reassign)\s+(TASK-\d+)\s+to\s+(.+))$/i);
    if (taskReassignMatch) {
      const taskId = (taskReassignMatch[1] ?? taskReassignMatch[3])!;
      const newAssignee = (taskReassignMatch[2] ?? taskReassignMatch[4])!.trim();
      log.debug("Fast-path: task reassign", { taskId });
      await this.deps.reassignTask.execute({
        taskId, conversationId: convId, newAssigneeReference: newAssignee, actorId: sender, replyToMessageId: wireMessage.id,
      });
      return;
    }

    // TASK-NNNN due <expression>
    const taskDeadlineMatch = text.match(/^(TASK-\d+)\s+due\s+(.+)$/i);
    if (taskDeadlineMatch) {
      log.debug("Fast-path: task deadline update", { taskId: taskDeadlineMatch[1] });
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.updateTaskDeadline.execute({
        taskId: taskDeadlineMatch[1], conversationId: convId, actorId: sender,
        deadlineText: taskDeadlineMatch[2].trim(), timezone: config?.timezone ?? "UTC",
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    // ACT-NNNN reassign / assign ACT-NNNN to <name>
    const actReassignMatch = text.match(/^(?:(ACT-\d+)\s+reassign\s+to\s+(.+)|(?:assign|reassign)\s+(ACT-\d+)\s+to\s+(.+))$/i);
    if (actReassignMatch) {
      const actionId = (actReassignMatch[1] ?? actReassignMatch[3])!;
      const newAssignee = (actReassignMatch[2] ?? actReassignMatch[4])!.trim();
      log.debug("Fast-path: action reassign", { actionId });
      await this.deps.reassignAction.execute({
        actionId, conversationId: convId,
        newAssigneeReference: newAssignee, actorId: sender, replyToMessageId: wireMessage.id,
      });
      return;
    }

    // ACT-NNNN status or status ACT-NNNN
    const actDoneMatch = text.match(/^(?:(ACT-\d+)\s+(done|cancelled|in[_\s]progress|close|complete|cancel)|(done|close|complete|cancel|cancelled|in[_\s]progress)\s+(ACT-\d+))\s*(.*)$/i);
    if (actDoneMatch) {
      const actionId = (actDoneMatch[1] ?? actDoneMatch[4])!;
      const rawStatus = (actDoneMatch[2] ?? actDoneMatch[3])!.toLowerCase();
      const note = actDoneMatch[5]?.trim() || undefined;
      const normStatus = rawStatus === "close" || rawStatus === "complete" ? "done"
        : rawStatus === "cancel" ? "cancelled"
        : rawStatus.replace(/\s/, "_") as ActionStatus;
      log.debug("Fast-path: action status update", { actionId, newStatus: normStatus });
      await this.deps.updateActionStatus.execute({
        actionId, newStatus: normStatus as "done" | "cancelled" | "in_progress",
        conversationId: convId, actorId: sender,
        completionNote: note, replyToMessageId: wireMessage.id,
      });
      return;
    }

    // ACT-NNNN due <expression>
    const actDeadlineMatch = text.match(/^(ACT-\d+)\s+due\s+(.+)$/i);
    if (actDeadlineMatch) {
      log.debug("Fast-path: action deadline update", { actionId: actDeadlineMatch[1] });
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.updateActionDeadline.execute({
        actionId: actDeadlineMatch[1], conversationId: convId, actorId: sender,
        deadlineText: actDeadlineMatch[2].trim(), timezone: config?.timezone ?? "UTC",
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    const revokeMatch = text.match(/^revoke\s+(DEC-\d+)\s*(.*)$/i);
    if (revokeMatch) {
      log.debug("Fast-path: revoke decision", { decisionId: revokeMatch[1] });
      await this.deps.revokeDecision.execute({
        conversationId: convId, actorId: sender,
        decisionId: revokeMatch[1], reason: revokeMatch[2].trim() || undefined, replyToMessageId: wireMessage.id,
      });
      return;
    }

    const supersedeMatch = text.match(/^decision:\s*(.+?)\s+supersedes\s+(DEC-\d+)\s*$/i);
    if (supersedeMatch) {
      log.debug("Fast-path: supersede decision", { supersedes: supersedeMatch[2] });
      await this.deps.supersedeDecision.execute({
        conversationId: convId, authorId: sender, authorName: "",
        rawMessageId: wireMessage.id, rawMessage: text,
        newSummary: supersedeMatch[1].trim(), supersedesDecisionId: supersedeMatch[2],
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    // Exact list commands — no LLM needed
    if (lowered === "my tasks" || lowered === "my task") {
      await this.deps.listMyTasks.execute({ conversationId: convId, assigneeId: sender, replyToMessageId: wireMessage.id });
      return;
    }
    if (lowered === "team tasks" || lowered === "all tasks" || lowered === "list team tasks") {
      await this.deps.listTeamTasks.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
      return;
    }
    if (lowered === "my actions" || lowered === "my action") {
      await this.deps.listMyActions.execute({ conversationId: convId, assigneeId: sender, replyToMessageId: wireMessage.id });
      return;
    }
    if (lowered === "team actions" || lowered === "team action") {
      await this.deps.listTeamActions.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
      return;
    }
    if (lowered === "overdue actions" || lowered === "overdue" || lowered === "overdue tasks") {
      await this.deps.listOverdueActions.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
      return;
    }
    if (lowered === "my reminders" || lowered === "show reminders" || lowered === "list reminders" || lowered === "reminders") {
      await this.deps.listMyReminders.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
      return;
    }
    if (lowered === "list decisions" || lowered === "decisions" || lowered === "decisions list") {
      await this.deps.listDecisions.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
      return;
    }

    // ── Single-pass intelligence: intent + capture + shouldRespond ────────────
    const recentAll = this.deps.messageBuffer.getLastN(convId, CONTEXT_WINDOW);
    const previousMessageText = recentAll.length >= 2 ? recentAll[recentAll.length - 2].text : undefined;
    const actioned = this.actionedMessageIds.get(convKey) ?? new Set<string>();
    const recentFiltered = recentAll.filter((m) => !actioned.has(m.messageId));

    const config = await this.deps.conversationConfig.get(convId);
    const sensitivity = (config?.sensitivity ?? "normal") as "strict" | "normal" | "aggressive";

    let intelligence: ConversationIntelligenceResult;
    try {
      intelligence = await this.deps.conversationIntelligence.analyze({
        currentMessage: text,
        currentMessageId: wireMessage.id,
        previousMessageText,
        recentMessages: recentFiltered.map((m) => ({ senderId: m.senderId, text: m.text, messageId: m.messageId })),
        sensitivity,
        conversationId: convId,
      });
    } catch (err) {
      log.warn("Conversation intelligence failed", { err: String(err) });
      intelligence = { intent: "none", payload: {}, confidence: 0, shouldRespond: false };
    }

    // If the bot was explicitly @mentioned, always respond regardless of LLM decision.
    const botMentioned = wireMessage.mentions?.some((m) => m.userId.id === this.deps.botUserId.id) ?? false;
    if (botMentioned && !intelligence.shouldRespond) {
      intelligence = { ...intelligence, shouldRespond: true };
    }

    log.debug("Intelligence result", {
      intent: intelligence.intent,
      confidence: intelligence.confidence,
      shouldRespond: intelligence.shouldRespond,
      hasCapture: !!intelligence.capture,
      botMentioned,
    });

    // Phase 3: shouldRespond gates the whole response path
    if (!intelligence.shouldRespond) {
      // Even if bot won't reply, a capture candidate may still be presented
      if (intelligence.capture && intelligence.capture.confidence >= IMPLICIT_KNOWLEDGE_MIN_CONFIDENCE
          && config?.implicitDetectionEnabled !== false) {
        await this.presentCapture(intelligence.capture, wireMessage, convId, sender, convKey, log);
      }
      return;
    }

    if (intelligence.confidence >= INTENT_CONFIDENCE_THRESHOLD && intelligence.intent !== "none") {
      await this.routeIntent(intelligence, wireMessage, convId, sender, convKey, previousMessageText, log);
      // Mark creating intents as actioned to prevent passive re-capture
      const creatingIntents = new Set([
        "create_task", "update_task", "update_task_status", "create_decision", "supersede_decision",
        "create_action", "update_action", "update_action_status", "reassign_action",
        "create_reminder", "cancel_reminder", "snooze_reminder",
        "store_knowledge", "update_knowledge", "delete_knowledge",
      ]);
      if (creatingIntents.has(intelligence.intent)) {
        this.markActioned(convKey, wireMessage.id);
      }
      return;
    }

    // No actionable intent but shouldRespond — try capture if available, then fall back to help
    if (intelligence.capture && intelligence.capture.confidence >= IMPLICIT_KNOWLEDGE_MIN_CONFIDENCE
        && config?.implicitDetectionEnabled !== false) {
      await this.presentCapture(intelligence.capture, wireMessage, convId, sender, convKey, log);
      return;
    }

    if (botMentioned) {
      await this.deps.wireOutbound.sendPlainText(convId, HELP_TEXT, { replyToMessageId: wireMessage.id });
    }
  }

  private async presentCapture(
    capture: NonNullable<ConversationIntelligenceResult["capture"]>,
    wireMessage: TextMessage,
    convId: QualifiedId,
    sender: QualifiedId,
    convKey: string,
    log: Logger,
  ): Promise<void> {
    if (capture.type !== "knowledge") return; // only knowledge capture is currently interactive
    log.debug("Presenting knowledge capture prompt", { confidence: capture.confidence });
    const display = capture.summary.slice(0, 150);
    this.pendingKnowledge.set(convKey, {
      summary: capture.summary,
      detail: capture.detail || capture.summary,
      authorId: sender,
      rawMessageId: wireMessage.id,
      rawMessage: wireMessage.text ?? "",
    });
    this.markActioned(convKey, wireMessage.id);
    await this.deps.wireOutbound.sendCompositePrompt(
      convId,
      `Shall I remember that?\n> ${display}`,
      [{ id: "confirm_knowledge", label: "Confirm" }, { id: "dismiss", label: "Dismiss" }],
      { replyToMessageId: wireMessage.id },
    );
  }

  private async routeIntent(
    result: ConversationIntelligenceResult,
    wireMessage: TextMessage,
    convId: QualifiedId,
    sender: QualifiedId,
    convKey: string,
    previousMessageText: string | undefined,
    log: Logger,
  ): Promise<void> {
    const p = result.payload;
    const rawText = wireMessage.text ?? "";
    log.debug("Routing intent", { intent: result.intent });

    switch (result.intent) {
      // ── Tasks ──────────────────────────────────────────────────────────────
      case "create_task":
        await this.deps.createTaskFromExplicit.execute({
          conversationId: convId, authorId: sender, authorName: "",
          rawMessageId: wireMessage.id, rawMessage: rawText,
          description: p.description ?? rawText,
          assigneeReference: p.assignee ?? undefined,
          deadlineText: p.deadline ?? undefined,
          priority: (p.priority as TaskPriority) ?? undefined,
        });
        break;
      case "update_task":
      case "update_task_status": {
        const taskId = p.entityId;
        if (!taskId) break;
        if (p.newStatus || p.newAssignee || p.newDeadline || p.newPriority) {
          await this.deps.updateTask.execute({
            taskId, conversationId: convId, actorId: sender, replyToMessageId: wireMessage.id,
            newStatus: p.newStatus as TaskStatus | undefined,
            newAssigneeReference: p.newAssignee,
            newDeadlineText: p.newDeadline,
            newPriority: p.newPriority as TaskPriority | undefined,
          });
        } else if (p.newStatus) {
          const norm = p.newStatus.toLowerCase().replace(/\s+/g, "_") as TaskStatus;
          await this.deps.updateTaskStatus.execute({ taskId, newStatus: norm, conversationId: convId, actorId: sender, replyToMessageId: wireMessage.id });
        }
        break;
      }
      // ── Decisions ─────────────────────────────────────────────────────────
      case "create_decision": {
        const contextMessages = this.deps.messageBuffer.getLastN(convId, CONTEXT_WINDOW);
        const participantIds = contextMessages.length
          ? [...new Map(contextMessages.map((m) => [m.senderId.id, m.senderId])).values()]
          : [sender];
        await this.deps.logDecision.execute({
          conversationId: convId, authorId: sender, authorName: "",
          rawMessageId: wireMessage.id, rawMessage: rawText,
          summary: p.summary ?? rawText, contextMessages, participantIds,
        });
        break;
      }
      case "supersede_decision":
        if (p.supersedesId) {
          await this.deps.supersedeDecision.execute({
            conversationId: convId, authorId: sender, authorName: "",
            rawMessageId: wireMessage.id, rawMessage: rawText,
            newSummary: p.newSummary ?? p.summary ?? rawText,
            supersedesDecisionId: p.supersedesId,
            replyToMessageId: wireMessage.id,
          });
        }
        break;
      // ── Actions ────────────────────────────────────────────────────────────
      case "create_action":
        await this.deps.createActionFromExplicit.execute({
          conversationId: convId, creatorId: sender, authorName: "",
          rawMessageId: wireMessage.id, rawMessage: rawText,
          description: p.description ?? rawText,
          assigneeReference: p.assignee ?? undefined,
          deadlineText: p.deadline ?? undefined,
        });
        break;
      case "update_action":
      case "update_action_status": {
        const actionId = p.entityId;
        if (!actionId) break;
        if (p.newAssignee || p.newDeadline) {
          await this.deps.updateAction.execute({
            actionId, conversationId: convId, actorId: sender, replyToMessageId: wireMessage.id,
            newStatus: p.newStatus as ActionStatus | undefined,
            newAssigneeReference: p.newAssignee,
            newDeadlineText: p.newDeadline,
          });
        } else if (p.newStatus) {
          const norm = p.newStatus.toLowerCase().replace(/\s+/g, "_") as "done" | "cancelled" | "in_progress";
          await this.deps.updateActionStatus.execute({ actionId, newStatus: norm, conversationId: convId, actorId: sender, replyToMessageId: wireMessage.id });
        }
        break;
      }
      case "reassign_action":
        if (p.entityId && p.newAssignee) {
          await this.deps.reassignAction.execute({
            actionId: p.entityId, conversationId: convId, newAssigneeReference: p.newAssignee, actorId: sender, replyToMessageId: wireMessage.id,
          });
        }
        break;
      // ── Reminders ─────────────────────────────────────────────────────────
      case "create_reminder": {
        if (!p.timeExpression) {
          await this.deps.wireOutbound.sendPlainText(convId,
            "I couldn't figure out when you want the reminder. Try: _\"remind me at 3pm to call John\"_ or _\"reminder in 2 hours check the build\"_.",
            { replyToMessageId: wireMessage.id });
          return;
        }
        const config = await this.deps.conversationConfig.get(convId);
        const timezone = config?.timezone ?? "UTC";
        const parsed = this.deps.dateTimeService.parse(p.timeExpression, { timezone });
        if (!parsed?.value) {
          await this.deps.wireOutbound.sendPlainText(convId,
            `Sorry, I couldn't parse _"${p.timeExpression}"_. Try: _"remind me at 3pm to call John"_ or _"reminder in 2 hours check the build"_.`,
            { replyToMessageId: wireMessage.id });
          return;
        }
        await this.deps.createReminder.execute({
          conversationId: convId, authorId: sender, authorName: "",
          rawMessageId: wireMessage.id, rawMessage: rawText,
          description: p.description ?? "Reminder",
          targetId: sender, triggerAt: parsed.value,
        });
        break;
      }
      case "cancel_reminder":
        if (p.entityId) {
          await this.deps.cancelReminder.execute({
            reminderId: p.entityId, conversationId: convId, actorId: sender, replyToMessageId: wireMessage.id,
          });
        }
        break;
      case "snooze_reminder": {
        if (!p.entityId || !p.snoozeExpression) break;
        const cfg = await this.deps.conversationConfig.get(convId);
        await this.deps.snoozeReminder.execute({
          reminderId: p.entityId, conversationId: convId, actorId: sender,
          snoozeExpression: p.snoozeExpression, timezone: cfg?.timezone ?? "UTC",
          replyToMessageId: wireMessage.id,
        });
        break;
      }
      // ── Knowledge ─────────────────────────────────────────────────────────
      case "store_knowledge": {
        const content = p.usePreviousMessage && previousMessageText
          ? previousMessageText
          : (p.detail ?? p.summary ?? rawText);
        const summary = p.usePreviousMessage && previousMessageText
          ? (previousMessageText.length > 120 ? `${previousMessageText.slice(0, 117)}…` : previousMessageText)
          : (p.summary ?? (content.length > 120 ? `${content.slice(0, 117)}…` : content));
        if (!content || (content === rawText && p.usePreviousMessage)) {
          await this.deps.wireOutbound.sendPlainText(convId,
            "There's no previous message to remember. Please tell me what to store.",
            { replyToMessageId: wireMessage.id });
          return;
        }
        await this.deps.storeKnowledge.execute({
          conversationId: convId, authorId: sender, authorName: "",
          rawMessageId: wireMessage.id, rawMessage: rawText,
          summary, detail: content,
        });
        break;
      }
      case "retrieve_knowledge": {
        // Unified RAG path: search KB and synthesise via LLM (same as general_question)
        const question = p.query ?? rawText;
        if (question.length > 0) {
          const recentContext = this.deps.messageBuffer
            .getLastN(convId, CONTEXT_WINDOW)
            .slice(0, -1)
            .map((m) => m.text);
          await this.deps.answerQuestion.execute({
            question,
            conversationContext: recentContext,
            conversationId: convId,
            replyToMessageId: wireMessage.id,
          });
        }
        break;
      }
      case "update_knowledge":
        if (p.entityId) {
          await this.deps.updateKnowledge.execute({
            knowledgeId: p.entityId, conversationId: convId, actorId: sender,
            newSummary: p.newSummary, newDetail: p.newDetail, replyToMessageId: wireMessage.id,
          });
        }
        break;
      case "delete_knowledge":
        if (p.entityId) {
          await this.deps.deleteKnowledge.execute({
            knowledgeId: p.entityId, conversationId: convId, actorId: sender, replyToMessageId: wireMessage.id,
          });
        }
        break;
      // ── Lists ─────────────────────────────────────────────────────────────
      case "list_my_tasks":
        await this.deps.listMyTasks.execute({ conversationId: convId, assigneeId: sender, replyToMessageId: wireMessage.id });
        break;
      case "list_team_tasks":
        await this.deps.listTeamTasks.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
        break;
      case "list_decisions":
        if (p.query) {
          await this.deps.searchDecisions.execute({ conversationId: convId, searchText: p.query, replyToMessageId: wireMessage.id });
        } else {
          await this.deps.listDecisions.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
        }
        break;
      case "list_my_actions":
        await this.deps.listMyActions.execute({ conversationId: convId, assigneeId: sender, replyToMessageId: wireMessage.id });
        break;
      case "list_team_actions":
        await this.deps.listTeamActions.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
        break;
      case "list_overdue_actions":
        await this.deps.listOverdueActions.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
        break;
      case "list_reminders":
        await this.deps.listMyReminders.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
        break;
      // ── Meta ──────────────────────────────────────────────────────────────
      case "general_question": {
        const recentContext = this.deps.messageBuffer
          .getLastN(convId, CONTEXT_WINDOW)
          .slice(0, -1)
          .map((m) => m.text);
        await this.deps.answerQuestion.execute({
          question: rawText,
          conversationContext: recentContext,
          conversationId: convId,
          replyToMessageId: wireMessage.id,
        });
        break;
      }
      case "help":
        await this.deps.wireOutbound.sendPlainText(convId, HELP_TEXT, { replyToMessageId: wireMessage.id });
        break;
      case "secret_mode_on":
        await this.enterSecretMode(convId, convKey, wireMessage.id, sender, log);
        break;
      case "secret_mode_off":
        await this.exitSecretMode(convId, convKey, wireMessage.id, log);
        break;
    }
  }

  private async enterSecretMode(
    convId: QualifiedId, convKey: string, replyToMessageId: string, _sender: QualifiedId, log: Logger,
  ): Promise<void> {
    this.secretModeConvs.add(convKey);
    log.info("Entering secret mode", { conversationId: convId.id });
    const existing = await this.deps.conversationConfig.get(convId);
    await this.deps.conversationConfig.upsert({
      conversationId: convId, timezone: existing?.timezone ?? "UTC", locale: existing?.locale ?? "en",
      secretMode: true, implicitDetectionEnabled: existing?.implicitDetectionEnabled,
      sensitivity: existing?.sensitivity, raw: existing?.raw ?? null,
    });
    this.scheduleInactivityCheck(convId, convKey);
    await this.deps.wireOutbound.sendPlainText(convId,
      "I've gone quiet. I won't record anything from this conversation until you ask me to resume.",
      { replyToMessageId });
  }

  private async exitSecretMode(
    convId: QualifiedId, convKey: string, replyToMessageId: string, log: Logger,
  ): Promise<void> {
    this.secretModeConvs.delete(convKey);
    this.deps.scheduler.cancel(`secret-inactivity-${convKey}`);
    log.info("Exiting secret mode", { conversationId: convId.id });
    const existing = await this.deps.conversationConfig.get(convId);
    await this.deps.conversationConfig.upsert({
      conversationId: convId, timezone: existing?.timezone ?? "UTC", locale: existing?.locale ?? "en",
      secretMode: false, implicitDetectionEnabled: existing?.implicitDetectionEnabled,
      sensitivity: existing?.sensitivity, raw: existing?.raw ?? null,
    });
    await this.deps.wireOutbound.sendPlainText(convId, "I'm listening again.", { replyToMessageId });
  }

  private markActioned(convKey: string, messageId: string): void {
    let set = this.actionedMessageIds.get(convKey);
    if (!set) { set = new Set(); this.actionedMessageIds.set(convKey, set); }
    set.add(messageId);
    if (set.size > 200) set.delete(set.values().next().value as string);
  }

  private scheduleInactivityCheck(convId: QualifiedId, convKey: string): void {
    this.deps.scheduler.cancel(`secret-inactivity-${convKey}`);
    this.deps.scheduler.schedule({
      id: `secret-inactivity-${convKey}`, type: "secret_inactivity",
      runAt: new Date(Date.now() + this.deps.secretModeInactivityMs),
      payload: { convId },
    });
  }

  async handleSecretModeInactivityCheck(convId: QualifiedId): Promise<void> {
    const convKey = `${convId.id}@${convId.domain}`;
    if (!this.secretModeConvs.has(convKey)) return;
    const lastActivity = this.lastActivityByConv.get(convKey) ?? 0;
    const inactiveMs = Date.now() - lastActivity;
    if (inactiveMs >= this.deps.secretModeInactivityMs) {
      this.deps.logger.debug("Secret mode inactivity prompt sent", { conversationId: convId.id });
      await this.deps.wireOutbound.sendPlainText(convId,
        "This conversation has been quiet for a while. Type _\"resume\"_ whenever you'd like me to start listening again.");
    } else {
      this.deps.scheduler.schedule({
        id: `secret-inactivity-${convKey}`, type: "secret_inactivity",
        runAt: new Date(lastActivity + this.deps.secretModeInactivityMs),
        payload: { convId },
      });
    }
  }

  async onButtonActionReceived(wireMessage: ButtonActionMessage): Promise<void> {
    const convId = wireMessage.conversationId as QualifiedId;
    const senderId = wireMessage.sender as QualifiedId;
    const { buttonId, referenceMessageId } = wireMessage;
    const convKey = `${convId.id}@${convId.domain}`;
    const log = this.deps.logger.child({ conversationId: convId.id, senderId: senderId.id, buttonId });

    switch (buttonId) {
      case "confirm_knowledge": {
        const pending = this.pendingKnowledge.get(convKey);
        if (pending) {
          this.pendingKnowledge.delete(convKey);
          this.markActioned(convKey, pending.rawMessageId);
          try {
            await this.deps.storeKnowledge.execute({
              conversationId: convId, authorId: pending.authorId, authorName: "",
              rawMessageId: pending.rawMessageId, rawMessage: pending.rawMessage,
              summary: pending.summary, detail: pending.detail,
            });
          } catch (err) {
            log.error("Failed to store confirmed knowledge", { err: String(err) });
          }
        }
        break;
      }
      case "dismiss":
        this.pendingKnowledge.delete(convKey);
        this.markActioned(convKey, wireMessage.referenceMessageId ?? "");
        break;
      case "yes":
        await this.deps.wireOutbound.sendPlainText(convId, "Use _\"action: <description>\"_ to log the action.");
        break;
      case "no":
        break;
      default:
        log.warn("Unhandled button action", { buttonId });
    }

    try {
      await this.manager.sendMessage(
        ButtonActionConfirmationMessage.create({ conversationId: convId, referenceMessageId, buttonId }),
      );
    } catch {
      // manager not available in tests or before SDK initialisation — safe to ignore
    }
  }

  async onAppAddedToConversation(conversation: Conversation, members: ConversationMember[]): Promise<void> {
    const convId = { id: conversation.id, domain: conversation.domain } as QualifiedId;
    this.deps.memberCache.setMembers(convId, toCachedMembers(members));
  }

  async onConversationDeleted(conversationId: QualifiedId): Promise<void> {
    this.deps.memberCache.clearConversation(conversationId as QualifiedId);
  }

  async onUserJoinedConversation(conversationId: QualifiedId, members: ConversationMember[]): Promise<void> {
    this.deps.memberCache.addMembers(conversationId as QualifiedId, toCachedMembers(members));
  }

  async onUserLeftConversation(conversationId: QualifiedId, members: QualifiedId[]): Promise<void> {
    this.deps.memberCache.removeMembers(conversationId as QualifiedId, members as QualifiedId[]);
  }
}
