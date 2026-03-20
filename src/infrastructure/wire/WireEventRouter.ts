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
import type { ListKnowledge } from "../../application/usecases/knowledge/ListKnowledge";
import { PendingActionBuffer } from "../../application/services/PendingActionBuffer";
import type { DeleteKnowledge } from "../../application/usecases/knowledge/DeleteKnowledge";
import type { UpdateKnowledge } from "../../application/usecases/knowledge/UpdateKnowledge";
import type { AnswerQuestion } from "../../application/usecases/general/AnswerQuestion";
import type { ConversationMessageBuffer } from "../../application/services/ConversationMessageBuffer";
import type { DateTimeService } from "../../domain/services/DateTimeService";
import type { ConversationMemberCache, CachedMember } from "../../domain/services/ConversationMemberCache";
import type { ConversationConfigRepository } from "../../domain/repositories/ConversationConfigRepository";
import type { ChannelConfigRepository } from "../../domain/repositories/ChannelConfigRepository";
import type { ConversationIntelligenceService, ConversationIntelligenceResult } from "../../domain/services/ConversationIntelligenceService";
import type { WireOutboundPort } from "../../application/ports/WireOutboundPort";
import type { SchedulerPort } from "../../application/ports/SchedulerPort";
import type { Logger } from "../../application/ports/Logger";
import type { TaskPriority, TaskStatus } from "../../domain/entities/Task";
import type { ActionStatus } from "../../domain/entities/Action";
import type { SlidingWindowBuffer } from "../buffer/SlidingWindowBuffer";
import { toChannelId } from "./channelId";

const CONTEXT_WINDOW = 10;
const IMPLICIT_KNOWLEDGE_MIN_CONFIDENCE = 0.7;
const INTENT_CONFIDENCE_THRESHOLD = 0.75;

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
  listKnowledge: ListKnowledge;
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
  /** Legacy config repo — still used by existing use-cases (e.g. timezone lookup). Kept for Phase 1a compat. */
  conversationConfig: ConversationConfigRepository;
  /** New v2 channel config repo — drives the state machine. */
  channelConfig: ChannelConfigRepository;
  slidingWindow: SlidingWindowBuffer;
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

interface PendingCaptureConfirmation {
  type: "action" | "task" | "decision";
  summary: string;
  detail: string;
  authorId: QualifiedId;
  rawMessageId: string;
  rawMessage: string;
}

export class WireEventRouter extends WireEventsHandler {
  private readonly pendingKnowledge = new Map<string, PendingKnowledgeConfirmation>();
  private readonly pendingCaptures = new Map<string, PendingCaptureConfirmation>();
  /** In-memory channel state cache — authoritative source is channelConfig DB. */
  private readonly channelStateCache = new Map<string, "active" | "paused" | "secure">();
  private readonly lastActivityByConv = new Map<string, number>();
  private readonly knownConvs = new Set<string>();
  private readonly actionedMessageIds = new Map<string, Set<string>>();
  private readonly awaitingPurpose = new Set<string>();
  private readonly pendingActionBuffer = new PendingActionBuffer();

  constructor(private readonly deps: WireEventRouterDeps) {
    super();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Entry point
  // ─────────────────────────────────────────────────────────────────────────

  async onTextMessageReceived(wireMessage: TextMessage): Promise<void> {
    const text = wireMessage.text ?? "";
    const convId = wireMessage.conversationId as QualifiedId;
    const sender = wireMessage.sender as QualifiedId;
    const channelId = toChannelId(convId);
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
    this.lastActivityByConv.set(channelId, Date.now());

    // Hydrate channel state from DB on first message in this process lifetime.
    if (!this.knownConvs.has(channelId)) {
      this.knownConvs.add(channelId);
      await this.hydrateChannelState(convId, channelId, log);
    }

    try {
      await this.handleTextMessage(wireMessage, text, convId, sender, channelId, log);
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

  private async hydrateChannelState(convId: QualifiedId, channelId: string, log: Logger): Promise<void> {
    try {
      const cfg = await this.deps.channelConfig.get(channelId);
      if (cfg) {
        this.channelStateCache.set(channelId, cfg.state as "active" | "paused" | "secure");
        if (cfg.state === "secure") {
          this.scheduleInactivityCheck(convId, channelId);
          log.info("Channel state restored from DB", { state: cfg.state });
        }
        return;
      }
      // Fall back to legacy ConversationConfig for existing channels without a channel_config row.
      const legacyCfg = await this.deps.conversationConfig.get(convId);
      if (legacyCfg?.secretMode) {
        this.channelStateCache.set(channelId, "secure");
        this.scheduleInactivityCheck(convId, channelId);
        log.info("Channel state restored from legacy DB (secretMode=true)");
      } else {
        this.channelStateCache.set(channelId, "active");
      }
    } catch (err) {
      log.warn("Failed to hydrate channel state", { err: String(err) });
      this.channelStateCache.set(channelId, "active");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core message handler
  // ─────────────────────────────────────────────────────────────────────────

  private async handleTextMessage(
    wireMessage: TextMessage,
    text: string,
    convId: QualifiedId,
    sender: QualifiedId,
    channelId: string,
    log: Logger,
  ): Promise<void> {
    const lowered = text.trim().toLowerCase();
    const channelState = this.channelStateCache.get(channelId) ?? "active";

    // Resolve conversation members for LLM context injection
    const members = this.deps.memberCache.getMembers(convId).map((m) => ({
      id: m.userId.id,
      name: m.name,
    }));

    // Always push to sliding window regardless of state — flush happens on SECURE entry
    this.deps.slidingWindow.push(channelId, {
      messageId: wireMessage.id,
      authorId: sender.id,
      text,
      timestamp: new Date(),
    });

    // ── PAUSED state ──────────────────────────────────────────────────────────
    // Discard all messages silently EXCEPT direct @Jeeves commands for state changes.
    if (channelState === "paused") {
      const botMentioned = wireMessage.mentions?.some((m) => m.userId.id === this.deps.botUserId.id) ?? false;
      if (!botMentioned) {
        log.debug("Channel paused — message discarded");
        return;
      }
      // Only allow state-change commands while paused
      if (this.matchesResumeCommand(lowered)) {
        await this.setChannelState(convId, channelId, "active", sender.id, wireMessage.id, log);
        return;
      }
      if (this.matchesSecureCommand(lowered)) {
        await this.setChannelState(convId, channelId, "secure", sender.id, wireMessage.id, log);
        return;
      }
      await this.deps.wireOutbound.sendPlainText(
        convId,
        "I'm currently standing by. Say _\"resume\"_ or mention me to bring me back.",
        { replyToMessageId: wireMessage.id },
      );
      return;
    }

    // ── SECURE state ──────────────────────────────────────────────────────────
    // Same as PAUSED but sliding window was already flushed on entry.
    if (channelState === "secure") {
      this.scheduleInactivityCheck(convId, channelId);
      // Flush the token we just pushed — nothing should accumulate during secure
      this.deps.slidingWindow.flush(channelId);
      const botMentioned = wireMessage.mentions?.some((m) => m.userId.id === this.deps.botUserId.id) ?? false;
      if (botMentioned && this.matchesResumeCommand(lowered)) {
        await this.exitSecureMode(convId, channelId, wireMessage.id, log);
        return;
      }
      log.debug("Secure mode active — message discarded");
      return;
    }

    // ── ACTIVE state — normal processing ─────────────────────────────────────

    this.pendingActionBuffer.tick(convId, text);

    // ── Check for state-change commands first (before fast-path) ─────────────
    const botMentionedEarly = wireMessage.mentions?.some((m) => m.userId.id === this.deps.botUserId.id) ?? false;

    if (botMentionedEarly || this.startsWithJeeves(lowered)) {
      if (this.matchesPauseCommand(lowered)) {
        await this.setChannelState(convId, channelId, "paused", sender.id, wireMessage.id, log);
        return;
      }
      if (this.matchesSecureCommand(lowered)) {
        await this.setChannelState(convId, channelId, "secure", sender.id, wireMessage.id, log);
        return;
      }
      if (this.matchesResumeCommand(lowered)) {
        // Already active — acknowledge gracefully
        await this.deps.wireOutbound.sendPlainText(
          convId,
          "I am already at your service.",
          { replyToMessageId: wireMessage.id },
        );
        return;
      }
      // Context commands: @Jeeves context: <purpose>
      const contextMatch = this.matchContextCommand(text);
      if (contextMatch) {
        await this.handleContextCommand(contextMatch, convId, channelId, sender, wireMessage.id, log);
        return;
      }
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
    if (lowered === "knowledge" || lowered === "list knowledge" || lowered === "my knowledge" || lowered === "show knowledge") {
      await this.deps.listKnowledge.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
      return;
    }

    // ── Awaiting channel purpose ──────────────────────────────────────────────
    if (this.awaitingPurpose.has(channelId)) {
      const trimmed = text.trim();
      if (trimmed.length >= 10) {
        this.awaitingPurpose.delete(channelId);
        // Persist to both legacy and new channel config
        const existing = await this.deps.conversationConfig.get(convId);
        await this.deps.conversationConfig.upsert({
          conversationId: convId,
          timezone: existing?.timezone ?? "UTC",
          locale: existing?.locale ?? "en",
          secretMode: existing?.secretMode ?? false,
          implicitDetectionEnabled: existing?.implicitDetectionEnabled,
          sensitivity: existing?.sensitivity,
          purpose: trimmed,
          raw: existing?.raw ?? null,
        });
        // Also update channel_config if it exists
        const channelCfg = await this.deps.channelConfig.get(channelId);
        if (channelCfg) {
          await this.deps.channelConfig.upsert({ ...channelCfg, purpose: trimmed });
        }
        await this.deps.wireOutbound.sendPlainText(
          convId,
          "Thank you — I shall bear that in mind.",
          { replyToMessageId: wireMessage.id },
        );
        return;
      }
    }

    // ── Matured action processing ─────────────────────────────────────────────
    const maturedActions = this.pendingActionBuffer.popMatured(convId);
    for (const action of maturedActions) {
      void (async () => {
        try {
          await this.deps.createActionFromExplicit.execute({
            conversationId: convId, creatorId: action.authorId, authorName: "",
            rawMessageId: action.rawMessageId, rawMessage: action.rawMessage,
            description: action.description,
            assigneeReference: action.assigneeReference,
            deadlineText: action.deadlineText,
          });
          if (!action.assigneeReference && !action.deadlineText) {
            await this.deps.wireOutbound.sendPlainText(
              convId,
              `I noted an action from the conversation — _"${action.description.slice(0, 120)}"_. Would anyone like to take ownership, or shall I set a deadline?`,
            );
          }
        } catch (err: unknown) {
          log.warn("Failed to store matured action", { err: String(err) });
        }
      })();
    }

    // ── Single-pass intelligence ──────────────────────────────────────────────
    const recentAll = this.deps.messageBuffer.getLastN(convId, CONTEXT_WINDOW);
    const previousMessageText = recentAll.length >= 2 ? recentAll[recentAll.length - 2].text : undefined;
    const actioned = this.actionedMessageIds.get(channelId) ?? new Set<string>();
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
        members,
        conversationPurpose: config?.purpose,
      });
    } catch (err) {
      log.warn("Conversation intelligence failed", { err: String(err) });
      intelligence = { intent: "none", payload: {}, confidence: 0, shouldRespond: false };
    }

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

    if (!intelligence.shouldRespond) {
      if (intelligence.capture && intelligence.capture.confidence >= IMPLICIT_KNOWLEDGE_MIN_CONFIDENCE
          && config?.implicitDetectionEnabled !== false) {
        await this.presentCapture(intelligence.capture, wireMessage, convId, sender, channelId, log);
      }
      return;
    }

    if (intelligence.confidence >= INTENT_CONFIDENCE_THRESHOLD && intelligence.intent !== "none") {
      await this.routeIntent(intelligence, wireMessage, convId, sender, channelId, previousMessageText, log, members, config?.purpose);
      const creatingIntents = new Set([
        "create_task", "update_task", "update_task_status", "create_decision", "supersede_decision",
        "create_action", "update_action", "update_action_status", "reassign_action",
        "create_reminder", "cancel_reminder", "snooze_reminder",
        "store_knowledge", "update_knowledge", "delete_knowledge",
      ]);
      if (creatingIntents.has(intelligence.intent)) {
        this.markActioned(channelId, wireMessage.id);
      }
      return;
    }

    if (intelligence.capture && intelligence.capture.confidence >= IMPLICIT_KNOWLEDGE_MIN_CONFIDENCE
        && config?.implicitDetectionEnabled !== false) {
      await this.presentCapture(intelligence.capture, wireMessage, convId, sender, channelId, log);
      return;
    }

    if (botMentioned) {
      const recentContext = this.deps.messageBuffer
        .getLastN(convId, CONTEXT_WINDOW)
        .slice(0, -1)
        .map((m) => m.text);
      await this.deps.answerQuestion.execute({
        question: text,
        conversationContext: recentContext,
        conversationId: convId,
        replyToMessageId: wireMessage.id,
        members,
        conversationPurpose: config?.purpose,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Channel state machine
  // ─────────────────────────────────────────────────────────────────────────

  private async setChannelState(
    convId: QualifiedId,
    channelId: string,
    newState: "active" | "paused" | "secure",
    actorId: string,
    replyToMessageId: string,
    log: Logger,
  ): Promise<void> {
    const now = new Date();
    this.channelStateCache.set(channelId, newState);
    log.info("Channel state change", { channelId, newState });

    // Upsert channel_config row
    try {
      const existing = await this.deps.channelConfig.get(channelId);
      if (existing) {
        await this.deps.channelConfig.setState(channelId, newState, actorId, now);
        if (newState === "secure") {
          await this.deps.channelConfig.openSecureRange(channelId, now);
        } else if (existing.state === "secure" && newState !== "secure") {
          await this.deps.channelConfig.closeSecureRange(channelId, now);
        }
      }
    } catch (err) {
      log.warn("Failed to persist channel state", { err: String(err) });
    }

    // Also keep legacy ConversationConfig in sync for existing use-cases
    try {
      const legacyCfg = await this.deps.conversationConfig.get(convId);
      await this.deps.conversationConfig.upsert({
        conversationId: convId,
        timezone: legacyCfg?.timezone ?? "UTC",
        locale: legacyCfg?.locale ?? "en",
        secretMode: newState === "secure",
        implicitDetectionEnabled: legacyCfg?.implicitDetectionEnabled,
        sensitivity: legacyCfg?.sensitivity,
        purpose: legacyCfg?.purpose,
        raw: legacyCfg?.raw ?? null,
      });
    } catch { /* non-fatal */ }

    if (newState === "secure") {
      this.deps.slidingWindow.flush(channelId);
      this.scheduleInactivityCheck(convId, channelId);
      await this.deps.wireOutbound.sendPlainText(convId,
        "Of course. I have cleared my short-term recollection of this channel and shall disregard all proceedings until further notice.",
        { replyToMessageId });
    } else if (newState === "paused") {
      this.deps.scheduler.cancel(`secret-inactivity-${channelId}`);
      await this.deps.wireOutbound.sendPlainText(convId,
        "Understood. I shall step out. Do let me know when you require my attention again.",
        { replyToMessageId });
    } else {
      // active
      this.deps.scheduler.cancel(`secret-inactivity-${channelId}`);
      await this.deps.wireOutbound.sendPlainText(convId,
        "Very good. I shall resume my duties forthwith.",
        { replyToMessageId });
    }
  }

  private async exitSecureMode(
    convId: QualifiedId,
    channelId: string,
    replyToMessageId: string,
    log: Logger,
  ): Promise<void> {
    // Re-use setChannelState for consistency
    await this.setChannelState(convId, channelId, "active", "", replyToMessageId, log);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Context command handler
  // ─────────────────────────────────────────────────────────────────────────

  private async handleContextCommand(
    match: ContextCommandMatch,
    convId: QualifiedId,
    channelId: string,
    sender: QualifiedId,
    replyToMessageId: string,
    log: Logger,
  ): Promise<void> {
    try {
      const existing = await this.deps.channelConfig.get(channelId);
      const base = existing ?? {
        channelId,
        organisationId: convId.domain,
        state: "active" as const,
        secureRanges: [],
        timezone: "UTC",
        locale: "en",
      };

      const now = new Date();
      const updated = { ...base };

      switch (match.field) {
        case "purpose":
          updated.purpose = match.value;
          break;
        case "type":
          updated.contextType = match.value as "customer" | "project" | "team" | "general";
          break;
        case "tags":
          updated.tags = match.value.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
          break;
        case "stakeholders":
          updated.stakeholders = match.value.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
          break;
        case "related":
          updated.relatedChannels = match.value.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
          break;
      }

      updated.contextUpdatedAt = now;
      updated.contextUpdatedBy = sender.id;

      await this.deps.channelConfig.upsert(updated);

      // Keep legacy config in sync for the purpose field
      if (match.field === "purpose") {
        const legacyCfg = await this.deps.conversationConfig.get(convId);
        await this.deps.conversationConfig.upsert({
          conversationId: convId,
          timezone: legacyCfg?.timezone ?? "UTC",
          locale: legacyCfg?.locale ?? "en",
          secretMode: legacyCfg?.secretMode ?? false,
          implicitDetectionEnabled: legacyCfg?.implicitDetectionEnabled,
          sensitivity: legacyCfg?.sensitivity,
          purpose: match.value,
          raw: legacyCfg?.raw ?? null,
        });
      }

      await this.deps.wireOutbound.sendPlainText(convId, "Noted. Context updated.", { replyToMessageId });
    } catch (err) {
      log.warn("Failed to update channel context", { err: String(err) });
      await this.deps.wireOutbound.sendPlainText(convId, "I'm afraid I was unable to update the channel context just now.", { replyToMessageId });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command pattern matchers
  // ─────────────────────────────────────────────────────────────────────────

  private startsWithJeeves(lowered: string): boolean {
    return lowered.startsWith("jeeves") || lowered.startsWith("@jeeves");
  }

  private stripJeevesPrefix(lowered: string): string {
    return lowered.replace(/^@?jeeves[,:]?\s*/i, "").trim();
  }

  private matchesPauseCommand(lowered: string): boolean {
    const stripped = this.stripJeevesPrefix(lowered);
    return /^(pause|step out)$/.test(stripped) || /^pause$/.test(lowered) || /^step out$/.test(lowered);
  }

  private matchesResumeCommand(lowered: string): boolean {
    const stripped = this.stripJeevesPrefix(lowered);
    return /^(resume|come back)$/.test(stripped) || /^(resume|come back)$/.test(lowered);
  }

  private matchesSecureCommand(lowered: string): boolean {
    const stripped = this.stripJeevesPrefix(lowered);
    return /^(secure mode|ears off|secure)$/.test(stripped)
      || /^(secure mode|ears off)$/.test(lowered);
  }

  private matchContextCommand(text: string): ContextCommandMatch | null {
    // @Jeeves context: <value>
    const purposeMatch = text.match(/^@?[Jj]eeves[,:]?\s+context:\s*(.+)$/i);
    if (purposeMatch) return { field: "purpose", value: purposeMatch[1].trim() };

    // @Jeeves context type: <value>
    const typeMatch = text.match(/^@?[Jj]eeves[,:]?\s+context\s+type:\s*(.+)$/i);
    if (typeMatch) return { field: "type", value: typeMatch[1].trim() };

    // @Jeeves context tags: <value>
    const tagsMatch = text.match(/^@?[Jj]eeves[,:]?\s+context\s+tags:\s*(.+)$/i);
    if (tagsMatch) return { field: "tags", value: tagsMatch[1].trim() };

    // @Jeeves context stakeholders: <value>
    const stakeholdersMatch = text.match(/^@?[Jj]eeves[,:]?\s+context\s+stakeholders:\s*(.+)$/i);
    if (stakeholdersMatch) return { field: "stakeholders", value: stakeholdersMatch[1].trim() };

    // @Jeeves context related: <value>
    const relatedMatch = text.match(/^@?[Jj]eeves[,:]?\s+context\s+related:\s*(.+)$/i);
    if (relatedMatch) return { field: "related", value: relatedMatch[1].trim() };

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Capture presentation
  // ─────────────────────────────────────────────────────────────────────────

  private async presentCapture(
    capture: NonNullable<ConversationIntelligenceResult["capture"]>,
    wireMessage: TextMessage,
    convId: QualifiedId,
    sender: QualifiedId,
    channelId: string,
    log: Logger,
  ): Promise<void> {
    const display = capture.summary.slice(0, 150);
    this.markActioned(channelId, wireMessage.id);

    if (capture.type === "knowledge") {
      log.debug("Silently storing knowledge capture", { confidence: capture.confidence });
      void this.deps.storeKnowledge.execute({
        conversationId: convId, authorId: sender, authorName: "",
        rawMessageId: wireMessage.id, rawMessage: wireMessage.text ?? "",
        summary: capture.summary, detail: capture.detail || capture.summary,
        silent: true,
      }).catch((err: unknown) => {
        log.warn("Failed to silently store knowledge capture", { err: String(err) });
      });
    } else if (capture.type === "action") {
      log.debug("Buffering action capture for delayed observation", { confidence: capture.confidence });
      this.pendingActionBuffer.add(convId, {
        description: capture.detail || capture.summary,
        authorId: sender,
        rawMessage: wireMessage.text ?? "",
        rawMessageId: wireMessage.id,
        capturedAt: new Date(),
        assigneeReference: typeof capture.payload.assignee === "string" ? capture.payload.assignee : undefined,
        deadlineText: typeof capture.payload.deadline === "string" ? capture.payload.deadline : undefined,
      });
    } else if (capture.type === "task" || capture.type === "decision") {
      const label = capture.type === "task" ? "a task" : "a decision";
      log.debug(`Presenting ${capture.type} capture prompt`, { confidence: capture.confidence });
      this.pendingCaptures.set(channelId, {
        type: capture.type,
        summary: capture.summary,
        detail: capture.detail || capture.summary,
        authorId: sender,
        rawMessageId: wireMessage.id,
        rawMessage: wireMessage.text ?? "",
      });
      await this.deps.wireOutbound.sendCompositePrompt(
        convId,
        `Shall I log this as ${label}?\n> ${display}`,
        [{ id: "confirm_capture", label: "Yes, log it" }, { id: "dismiss", label: "Dismiss" }],
        { replyToMessageId: wireMessage.id },
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Intent routing
  // ─────────────────────────────────────────────────────────────────────────

  private async routeIntent(
    result: ConversationIntelligenceResult,
    wireMessage: TextMessage,
    convId: QualifiedId,
    sender: QualifiedId,
    channelId: string,
    previousMessageText: string | undefined,
    log: Logger,
    members: Array<{ id: string; name?: string }>,
    conversationPurpose: string | undefined,
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
            members,
            conversationPurpose,
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
      case "general_question":
      case "help": {
        const recentContext = this.deps.messageBuffer
          .getLastN(convId, CONTEXT_WINDOW)
          .slice(0, -1)
          .map((m) => m.text);
        await this.deps.answerQuestion.execute({
          question: rawText,
          conversationContext: recentContext,
          conversationId: convId,
          replyToMessageId: wireMessage.id,
          members,
          conversationPurpose,
        });
        break;
      }
      // Legacy intent names — mapped to new state machine
      case "secret_mode_on":
        await this.setChannelState(convId, channelId, "secure", sender.id, wireMessage.id, log);
        break;
      case "secret_mode_off":
        await this.setChannelState(convId, channelId, "active", sender.id, wireMessage.id, log);
        break;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Inactivity check (SECURE mode only)
  // ─────────────────────────────────────────────────────────────────────────

  private scheduleInactivityCheck(convId: QualifiedId, channelId: string): void {
    this.deps.scheduler.cancel(`secret-inactivity-${channelId}`);
    this.deps.scheduler.schedule({
      id: `secret-inactivity-${channelId}`, type: "secret_inactivity",
      runAt: new Date(Date.now() + this.deps.secretModeInactivityMs),
      payload: { convId },
    });
  }

  async handleSecretModeInactivityCheck(convId: QualifiedId): Promise<void> {
    const channelId = toChannelId(convId);
    if (this.channelStateCache.get(channelId) !== "secure") return;
    const lastActivity = this.lastActivityByConv.get(channelId) ?? 0;
    const inactiveMs = Date.now() - lastActivity;
    if (inactiveMs >= this.deps.secretModeInactivityMs) {
      this.deps.logger.debug("Secure mode inactivity prompt sent", { conversationId: convId.id });
      await this.deps.wireOutbound.sendPlainText(convId,
        "This conversation has been quiet for a while. Say _\"resume\"_ whenever you'd like me to start listening again.");
    } else {
      this.deps.scheduler.schedule({
        id: `secret-inactivity-${channelId}`, type: "secret_inactivity",
        runAt: new Date(lastActivity + this.deps.secretModeInactivityMs),
        payload: { convId },
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Button actions
  // ─────────────────────────────────────────────────────────────────────────

  async onButtonActionReceived(wireMessage: ButtonActionMessage): Promise<void> {
    const convId = wireMessage.conversationId as QualifiedId;
    const senderId = wireMessage.sender as QualifiedId;
    const { buttonId, referenceMessageId } = wireMessage;
    const channelId = toChannelId(convId);
    const log = this.deps.logger.child({ conversationId: convId.id, senderId: senderId.id, buttonId });

    switch (buttonId) {
      case "confirm_knowledge": {
        const pending = this.pendingKnowledge.get(channelId);
        if (pending) {
          this.pendingKnowledge.delete(channelId);
          this.markActioned(channelId, pending.rawMessageId);
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
      case "confirm_capture": {
        const pending = this.pendingCaptures.get(channelId);
        if (pending) {
          this.pendingCaptures.delete(channelId);
          this.markActioned(channelId, pending.rawMessageId);
          try {
            if (pending.type === "action") {
              await this.deps.createActionFromExplicit.execute({
                conversationId: convId, creatorId: senderId, authorName: "",
                rawMessageId: pending.rawMessageId, rawMessage: pending.rawMessage,
                description: pending.detail,
              });
            } else if (pending.type === "task") {
              await this.deps.createTaskFromExplicit.execute({
                conversationId: convId, authorId: senderId, authorName: "",
                rawMessageId: pending.rawMessageId, rawMessage: pending.rawMessage,
                description: pending.detail,
              });
            } else if (pending.type === "decision") {
              await this.deps.logDecision.execute({
                conversationId: convId, authorId: senderId, authorName: "",
                rawMessageId: pending.rawMessageId, rawMessage: pending.rawMessage,
                summary: pending.summary, contextMessages: [], participantIds: [senderId],
              });
            }
          } catch (err) {
            log.error("Failed to store confirmed capture", { type: pending.type, err: String(err) });
          }
        }
        break;
      }
      case "dismiss":
        this.pendingKnowledge.delete(channelId);
        this.pendingCaptures.delete(channelId);
        this.markActioned(channelId, wireMessage.referenceMessageId ?? "");
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

  // ─────────────────────────────────────────────────────────────────────────
  // Conversation lifecycle events
  // ─────────────────────────────────────────────────────────────────────────

  async onAppAddedToConversation(conversation: Conversation, members: ConversationMember[]): Promise<void> {
    const convId = { id: conversation.id, domain: conversation.domain } as QualifiedId;
    const channelId = toChannelId(convId);
    this.deps.memberCache.setMembers(convId, toCachedMembers(members));

    // Determine personal mode: 2-member conversation (one is the bot itself)
    const nonBotMembers = members.filter((m) => m.userId.id !== this.deps.botUserId.id);
    const isPersonalMode = nonBotMembers.length === 1;

    // Upsert channel_config row with name and joined_at
    try {
      const now = new Date();
      const existing = await this.deps.channelConfig.get(channelId);
      await this.deps.channelConfig.upsert({
        channelId,
        channelName: (conversation as { name?: string }).name ?? existing?.channelName,
        organisationId: convId.domain,
        state: existing?.state ?? "active",
        secureRanges: existing?.secureRanges ?? [],
        purpose: existing?.purpose,
        contextType: existing?.contextType,
        tags: existing?.tags ?? [],
        stakeholders: existing?.stakeholders ?? [],
        relatedChannels: existing?.relatedChannels ?? [],
        timezone: existing?.timezone ?? "UTC",
        locale: existing?.locale ?? "en",
        joinedAt: existing?.joinedAt ?? now,
        isPersonalMode,
      });
    } catch {
      // Non-fatal — proceed without persisting
    }

    // Ask for channel purpose if not already set
    try {
      const channelCfg = await this.deps.channelConfig.get(channelId);
      if (!channelCfg?.purpose) {
        const legacyCfg = await this.deps.conversationConfig.get(convId);
        if (!legacyCfg?.purpose) {
          this.awaitingPurpose.add(channelId);
          await this.deps.wireOutbound.sendPlainText(
            convId,
            "Good day. I'm Jeeves, your team assistant. Before I begin, might I ask what this channel is used for? A brief description will help me serve the team more effectively.",
          );
        }
      }
    } catch {
      // Non-fatal
    }
  }

  async onConversationDeleted(conversationId: QualifiedId): Promise<void> {
    const channelId = toChannelId(conversationId);
    this.deps.memberCache.clearConversation(conversationId as QualifiedId);
    this.pendingActionBuffer.clearConversation(conversationId as QualifiedId);
    this.deps.slidingWindow.clear(channelId);
    this.channelStateCache.delete(channelId);
    this.knownConvs.delete(channelId);
  }

  async onUserJoinedConversation(conversationId: QualifiedId, members: ConversationMember[]): Promise<void> {
    this.deps.memberCache.addMembers(conversationId as QualifiedId, toCachedMembers(members));
    await this.updatePersonalMode(conversationId as QualifiedId);
  }

  async onUserLeftConversation(conversationId: QualifiedId, members: QualifiedId[]): Promise<void> {
    this.deps.memberCache.removeMembers(conversationId as QualifiedId, members as QualifiedId[]);
    await this.updatePersonalMode(conversationId as QualifiedId);
  }

  private async updatePersonalMode(convId: QualifiedId): Promise<void> {
    const channelId = toChannelId(convId);
    const allMembers = this.deps.memberCache.getMembers(convId);
    const nonBotMembers = allMembers.filter((m) => m.userId.id !== this.deps.botUserId.id);
    const isPersonalMode = nonBotMembers.length === 1;
    try {
      const existing = await this.deps.channelConfig.get(channelId);
      if (existing) {
        await this.deps.channelConfig.upsert({ ...existing, isPersonalMode });
      }
    } catch {
      // Non-fatal
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private markActioned(channelId: string, messageId: string): void {
    let set = this.actionedMessageIds.get(channelId);
    if (!set) { set = new Set(); this.actionedMessageIds.set(channelId, set); }
    set.add(messageId);
    if (set.size > 200) set.delete(set.values().next().value as string);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

type ContextField = "purpose" | "type" | "tags" | "stakeholders" | "related";

interface ContextCommandMatch {
  field: ContextField;
  value: string;
}
