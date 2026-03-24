import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { Conversation, ConversationMember, TextMessage, ButtonActionMessage } from "wire-apps-js-sdk";
import { WireEventsHandler, ButtonActionConfirmationMessage } from "wire-apps-js-sdk";
import type { LogDecision } from "../../application/usecases/decisions/LogDecision";
import type { CreateActionFromExplicit } from "../../application/usecases/actions/CreateActionFromExplicit";
import type { UpdateActionStatus } from "../../application/usecases/actions/UpdateActionStatus";
import type { ListMyActions } from "../../application/usecases/actions/ListMyActions";
import type { ListTeamActions } from "../../application/usecases/actions/ListTeamActions";
import type { ReassignAction } from "../../application/usecases/actions/ReassignAction";
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
import type { AnswerQuestion } from "../../application/usecases/general/AnswerQuestion";
import type { StatusCommand } from "../../application/usecases/general/StatusCommand";
import type { CatchMeUpCommand } from "../../application/usecases/general/CatchMeUpCommand";
import type { ConversationMessageBuffer } from "../../application/services/ConversationMessageBuffer";
import type { DateTimeService } from "../../domain/services/DateTimeService";
import type { ConversationMemberCache, CachedMember } from "../../domain/services/ConversationMemberCache";
import type { ConversationConfigRepository } from "../../domain/repositories/ConversationConfigRepository";
import type { ChannelConfigRepository } from "../../domain/repositories/ChannelConfigRepository";
import type { WireOutboundPort } from "../../application/ports/WireOutboundPort";
import type { SchedulerPort } from "../../application/ports/SchedulerPort";
import type { Logger } from "../../application/ports/Logger";
import type { ActionStatus } from "../../domain/entities/Action";
import type { SlidingWindowBuffer } from "../buffer/SlidingWindowBuffer";
import type { InMemoryProcessingQueue } from "../queue/InMemoryProcessingQueue";
import type { ProcessingPipeline, MessageJob } from "../pipeline/ProcessingPipeline";
import { toChannelId } from "./channelId";

const CONTEXT_WINDOW = 10;


export interface WireEventRouterDeps {
  logger: Logger;
  // Decisions
  logDecision: LogDecision;
  searchDecisions: SearchDecisions;
  listDecisions: ListDecisions;
  supersedeDecision: SupersedeDecision;
  revokeDecision: RevokeDecision;
  // Actions
  createActionFromExplicit: CreateActionFromExplicit;
  updateActionStatus: UpdateActionStatus;
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
  // General
  answerQuestion: AnswerQuestion;
  /** Phase 3: optional — reports channel state, entity counts, etc. */
  statusCommand?: StatusCommand;
  /** Phase 4: optional — handles "catch me up" / "what did I miss" queries. */
  catchMeUpCommand?: CatchMeUpCommand;
  // Infrastructure
  botUserId: QualifiedId;
  wireOutbound: WireOutboundPort;
  messageBuffer: ConversationMessageBuffer;
  dateTimeService: DateTimeService;
  memberCache: ConversationMemberCache;
  /** Legacy config repo — still used by existing use-cases (e.g. timezone lookup). Kept for Phase 1 compat. */
  conversationConfig: ConversationConfigRepository;
  /** v2 channel config repo — drives the state machine. */
  channelConfig: ChannelConfigRepository;
  slidingWindow: SlidingWindowBuffer;
  scheduler: SchedulerPort;
  secretModeInactivityMs: number;
  /**
   * Phase 2: background processing pipeline.
   * Optional — when not provided, the pipeline is disabled (tests / Phase 1 mode).
   */
  processingQueue?: InMemoryProcessingQueue<MessageJob>;
  pipeline?: ProcessingPipeline;
  /** Wire domain string used as org scope for pipeline extractions. Defaults to botUserId.domain. */
  orgId?: string;
}

export class WireEventRouter extends WireEventsHandler {
  private readonly channelStateCache = new Map<string, "active" | "paused" | "secure">();
  /** True when the channel is a 1:1 DM (one non-bot member). Enables personal-mode retrieval scope. */
  private readonly personalModeCache = new Map<string, boolean>();
  private readonly lastActivityByConv = new Map<string, number>();
  private readonly knownConvs = new Set<string>();

  private readonly awaitingPurpose = new Set<string>();

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


    const senderMember = this.deps.memberCache.getMembers(convId).find((m) => m.userId.id === sender.id);
    this.deps.messageBuffer.push(convId, {
      messageId: wireMessage.id,
      senderId: sender,
      senderName: senderMember?.name ?? "",
      text,
      timestamp: new Date(),
    });
    this.lastActivityByConv.set(channelId, Date.now());

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
        this.personalModeCache.set(channelId, cfg.isPersonalMode ?? false);
        if (cfg.state === "secure") this.scheduleInactivityCheck(convId, channelId);
        log.info("Channel state restored from DB", { state: cfg.state });
        return;
      }
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

    const members = this.deps.memberCache.getMembers(convId).map((m) => ({
      id: m.userId.id,
      domain: m.userId.domain,
      name: m.name,
    }));

    this.deps.slidingWindow.push(channelId, {
      messageId: wireMessage.id,
      authorId: sender.id,
      text,
      timestamp: new Date(),
    });

    // ── PAUSED ────────────────────────────────────────────────────────────────
    if (channelState === "paused") {
      const botMentioned = wireMessage.mentions?.some((m) => m.userId.id === this.deps.botUserId.id) ?? false;
      if (!botMentioned) {
        log.debug("Channel paused — message discarded");
        return;
      }
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

    // ── SECURE ────────────────────────────────────────────────────────────────
    if (channelState === "secure") {
      this.scheduleInactivityCheck(convId, channelId);
      this.deps.slidingWindow.flush(channelId);
      const botMentioned = wireMessage.mentions?.some((m) => m.userId.id === this.deps.botUserId.id) ?? false;
      if (botMentioned && this.matchesResumeCommand(lowered)) {
        await this.setChannelState(convId, channelId, "active", sender.id, wireMessage.id, log);
        return;
      }
      log.debug("Secure mode active — message discarded");
      return;
    }

    // ── ACTIVE — enqueue background pipeline job ──────────────────────────────
    if (this.deps.processingQueue && this.deps.pipeline) {
      const orgId = this.deps.orgId ?? convId.domain;
      const job: MessageJob = {
        messageId: wireMessage.id,
        channelId,
        conversationId: convId,
        senderId: sender,
        senderName: "",
        text,
        timestamp: new Date(),
        orgId,
      };
      this.deps.processingQueue.enqueue({
        id: wireMessage.id,
        channelId,
        payload: job,
        enqueuedAt: new Date(),
      });
    }

    // ── ACTIVE — state-change commands ────────────────────────────────────────
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
        await this.deps.wireOutbound.sendPlainText(convId, "I am already at your service.", { replyToMessageId: wireMessage.id });
        return;
      }
      const contextMatch = this.matchContextCommand(text);
      if (contextMatch) {
        await this.handleContextCommand(contextMatch, convId, channelId, sender, wireMessage.id, log);
        return;
      }

      // @Jeeves status
      if (/\bstatus\b/i.test(lowered) && this.deps.statusCommand) {
        await this.deps.statusCommand.execute({
          conversationId: convId,
          channelId,
          replyToMessageId: wireMessage.id,
        });
        return;
      }

      // @Jeeves catch me up / what did I miss
      if (
        /catch\s+me\s+up/i.test(lowered) ||
        /what(?:'s|\s+is|\s+was)?\s+(?:new|happening)/i.test(lowered) ||
        /what\s+did\s+i\s+miss/i.test(lowered)
      ) {
        if (this.deps.catchMeUpCommand) {
          const orgId = this.deps.orgId ?? convId.domain;
          await this.deps.catchMeUpCommand.execute({
            conversationId: convId,
            channelId,
            organisationId: orgId,
            replyToMessageId: wireMessage.id,
          });
          return;
        }
      }
    }

    // ── Fast-path: ID-based mutations ─────────────────────────────────────────

    // cancel REM-NNNN
    const cancelReminderMatch = text.match(/^cancel\s+(REM-\d+)\s*$/i);
    if (cancelReminderMatch) {
      await this.deps.cancelReminder.execute({
        reminderId: cancelReminderMatch[1], conversationId: convId, actorId: sender, replyToMessageId: wireMessage.id,
      });
      return;
    }

    // snooze REM-NNNN <expression>
    const snoozeReminderMatch = text.match(/^snooze\s+(REM-\d+)\s+(.+)$/i);
    if (snoozeReminderMatch) {
      const config = await this.deps.conversationConfig.get(convId);
      await this.deps.snoozeReminder.execute({
        reminderId: snoozeReminderMatch[1], conversationId: convId, actorId: sender,
        snoozeExpression: snoozeReminderMatch[2].trim(),
        timezone: config?.timezone ?? "UTC",
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    // ACT-NNNN reassign / assign ACT-NNNN to <name>
    const actReassignMatch = text.match(/^(?:(ACT-\d+)\s+reassign\s+to\s+(.+)|(?:assign|reassign)\s+(ACT-\d+)\s+to\s+(.+))$/i);
    if (actReassignMatch) {
      const actionId = (actReassignMatch[1] ?? actReassignMatch[3])!;
      const newAssignee = (actReassignMatch[2] ?? actReassignMatch[4])!.trim();
      await this.deps.reassignAction.execute({
        actionId, conversationId: convId, newAssigneeReference: newAssignee, actorId: sender, replyToMessageId: wireMessage.id,
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
      await this.deps.revokeDecision.execute({
        conversationId: convId, actorId: sender,
        decisionId: revokeMatch[1], reason: revokeMatch[2].trim() || undefined, replyToMessageId: wireMessage.id,
      });
      return;
    }

    const supersedeMatch = text.match(/^decision:\s*(.+?)\s+supersedes\s+(DEC-\d+)\s*$/i);
    if (supersedeMatch) {
      await this.deps.supersedeDecision.execute({
        conversationId: convId, authorId: sender, authorName: "",
        rawMessageId: wireMessage.id,
        newSummary: supersedeMatch[1].trim(), supersedesDecisionId: supersedeMatch[2],
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    // decision: <summary>
    const decisionMatch = text.match(/^decision:\s*(.+)$/i);
    if (decisionMatch) {
      const contextMessages = this.deps.messageBuffer.getLastN(convId, CONTEXT_WINDOW);
      const participantIds = contextMessages.length
        ? [...new Map(contextMessages.map((m) => [m.senderId.id, m.senderId])).values()]
        : [sender];
      await this.deps.logDecision.execute({
        conversationId: convId, authorId: sender, authorName: "",
        rawMessageId: wireMessage.id,
        summary: decisionMatch[1].trim(), contextMessages, participantIds,
      });
      return;
    }

    // action: <description>
    const actionMatch = text.match(/^action:\s*(.+)$/i);
    if (actionMatch) {
      await this.deps.createActionFromExplicit.execute({
        conversationId: convId, creatorId: sender, authorName: "",
        rawMessageId: wireMessage.id,
        description: actionMatch[1].trim(),
      });
      return;
    }

    // decisions about / search decisions <query>
    const decisionsSearchMatch = text.match(/^(?:decisions?\s+(?:about|on|for|regarding)|search\s+decisions?)\s+(.+)$/i);
    if (decisionsSearchMatch) {
      await this.deps.searchDecisions.execute({
        conversationId: convId, searchText: decisionsSearchMatch[1].trim(), replyToMessageId: wireMessage.id,
      });
      return;
    }

    // remind me <time-expression> to <description>
    const remindMatch = text.match(/^remind(?:\s+me)?\s+(.+?)\s+to\s+(.+)$/i)
                     ?? text.match(/^reminder\s+(.+?)\s+to\s+(.+)$/i);
    if (remindMatch) {
      const config = await this.deps.conversationConfig.get(convId);
      const parsed = this.deps.dateTimeService.parse(remindMatch[1].trim(), { timezone: config?.timezone ?? "UTC" });
      if (!parsed?.value) {
        await this.deps.wireOutbound.sendPlainText(convId,
          `I'm afraid I couldn't parse _"${remindMatch[1].trim()}"_ as a time. Try: _"remind me at 3pm to call John"_ or _"remind me in 2 hours to check the build"_.`,
          { replyToMessageId: wireMessage.id });
        return;
      }
      await this.deps.createReminder.execute({
        conversationId: convId, authorId: sender, authorName: "",
        rawMessageId: wireMessage.id,
        description: remindMatch[2].trim(), targetId: sender, triggerAt: parsed.value,
      });
      return;
    }

    // Retired TASK-* fast-paths — redirect to actions
    if (/^(?:TASK-\d+\s+.+|(?:done|close|complete|cancel|cancelled|in[_\s]progress)\s+TASK-\d+)/i.test(text)) {
      await this.deps.wireOutbound.sendPlainText(convId,
        "I'm afraid tasks have been consolidated into actions. Please use _ACT-NNNN_ identifiers going forward.",
        { replyToMessageId: wireMessage.id });
      return;
    }

    // Exact list commands
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

    // Retired task commands — redirect to action equivalents
    if (/^(my tasks?|list my tasks?)$/.test(lowered)) {
      await this.deps.listMyActions.execute({ conversationId: convId, assigneeId: sender, replyToMessageId: wireMessage.id });
      return;
    }
    if (/^(team tasks?|all tasks?|list team tasks?)$/.test(lowered)) {
      await this.deps.listTeamActions.execute({ conversationId: convId, replyToMessageId: wireMessage.id });
      return;
    }
    if (/^(knowledge|list knowledge|my knowledge|show knowledge)$/.test(lowered)) {
      await this.deps.wireOutbound.sendPlainText(convId,
        "I'm afraid the knowledge base has been reorganised. Ask me a question directly and I shall do my best to assist.",
        { replyToMessageId: wireMessage.id });
      return;
    }
    if (/^(?:forget|update)\s+KB-\d+/i.test(text)) {
      await this.deps.wireOutbound.sendPlainText(convId,
        "I'm afraid knowledge entries are no longer managed that way. The knowledge system is being rebuilt — do ask me questions directly in the meantime.",
        { replyToMessageId: wireMessage.id });
      return;
    }

    // ── Awaiting channel purpose ──────────────────────────────────────────────
    if (this.awaitingPurpose.has(channelId)) {
      const trimmed = text.trim();
      if (trimmed.length >= 10) {
        this.awaitingPurpose.delete(channelId);
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
        const channelCfg = await this.deps.channelConfig.get(channelId);
        if (channelCfg) {
          await this.deps.channelConfig.upsert({ ...channelCfg, purpose: trimmed });
        }
        await this.deps.wireOutbound.sendPlainText(convId, "Thank you — I shall bear that in mind.", { replyToMessageId: wireMessage.id });
        return;
      }
    }

    // ── @Jeeves mention — answer question ────────────────────────────────────
    if (botMentionedEarly) {
      const config = await this.deps.conversationConfig.get(convId);
      const recentContext = this.deps.messageBuffer.getLastN(convId, CONTEXT_WINDOW).slice(0, -1).map((m) =>
        m.senderName ? `${m.senderName}: ${m.text}` : m.text,
      );
      const orgId = this.deps.orgId ?? convId.domain;
      const isPersonal = this.personalModeCache.get(channelId) ?? false;
      const answer = await this.deps.answerQuestion.execute({
        question: text,
        conversationContext: recentContext,
        conversationId: convId,
        replyToMessageId: wireMessage.id,
        members,
        conversationPurpose: config?.purpose,
        channelId,
        orgId,
        userId: isPersonal ? sender.id : undefined,
      });
      // Push Jeeves' response into both buffers so follow-up messages have context.
      const botMsgId = `bot-${Date.now()}`;
      this.deps.messageBuffer.push(convId, {
        messageId: botMsgId,
        senderId: this.deps.botUserId,
        senderName: "Jeeves",
        text: answer,
        timestamp: new Date(),
      });
      this.deps.slidingWindow.push(channelId, {
        messageId: botMsgId,
        authorId: this.deps.botUserId.id,
        text: `[Jeeves] ${answer}`,
        timestamp: new Date(),
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
    const prevState = this.channelStateCache.get(channelId) ?? "active";
    this.channelStateCache.set(channelId, newState);
    log.info("Channel state change", { channelId, newState });

    try {
      const existing = await this.deps.channelConfig.get(channelId);
      if (existing) {
        await this.deps.channelConfig.setState(channelId, newState, actorId, now);
        if (newState === "secure") await this.deps.channelConfig.openSecureRange(channelId, now);
        else if (prevState === "secure") await this.deps.channelConfig.closeSecureRange(channelId, now);
      }
    } catch (err) {
      log.warn("Failed to persist channel state", { err: String(err) });
    }

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
      this.deps.scheduler.cancel(`secret-inactivity-${channelId}`);
      await this.deps.wireOutbound.sendPlainText(convId, "Very good. I shall resume my duties forthwith.", { replyToMessageId });
    }
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
        channelId, organisationId: convId.domain, state: "active" as const,
        secureRanges: [], timezone: "UTC", locale: "en",
      };
      const updated = { ...base, contextUpdatedAt: new Date(), contextUpdatedBy: sender.id };

      switch (match.field) {
        case "purpose":   updated.purpose = match.value; break;
        case "type":      updated.contextType = match.value as "customer" | "project" | "team" | "general"; break;
        case "tags":      updated.tags = match.value.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean); break;
        case "stakeholders": updated.stakeholders = match.value.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean); break;
        case "related":   updated.relatedChannels = match.value.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean); break;
      }

      await this.deps.channelConfig.upsert(updated);

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
      await this.deps.wireOutbound.sendPlainText(convId,
        "I'm afraid I was unable to update the channel context just now.", { replyToMessageId });
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
    const log = this.deps.logger.child({ conversationId: convId.id, senderId: senderId.id, buttonId });

    switch (buttonId) {
      default:
        log.warn("Unhandled button action", { buttonId });
    }

    try {
      await this.manager.sendMessage(
        ButtonActionConfirmationMessage.create({ conversationId: convId, referenceMessageId, buttonId }),
      );
    } catch {
      // manager not available in tests — safe to ignore
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Conversation lifecycle events
  // ─────────────────────────────────────────────────────────────────────────

  async onAppAddedToConversation(conversation: Conversation, members: ConversationMember[]): Promise<void> {
    const convId = { id: conversation.id, domain: conversation.domain } as QualifiedId;
    const channelId = toChannelId(convId);
    this.deps.memberCache.setMembers(convId, members.map((m) => ({
      userId: m.userId as QualifiedId,
      role: (m.role === "wire_admin" ? "admin" : "member") as CachedMember["role"],
    })));

    const nonBotMembers = members.filter((m) => m.userId.id !== this.deps.botUserId.id);
    const isPersonalMode = nonBotMembers.length === 1;
    this.personalModeCache.set(channelId, isPersonalMode);

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
    } catch { /* non-fatal */ }

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
    } catch { /* non-fatal */ }
  }

  async onConversationDeleted(conversationId: QualifiedId): Promise<void> {
    const channelId = toChannelId(conversationId);
    this.deps.memberCache.clearConversation(conversationId as QualifiedId);
    this.deps.slidingWindow.clear(channelId);
    this.channelStateCache.delete(channelId);
    this.knownConvs.delete(channelId);
  }

  async onUserJoinedConversation(conversationId: QualifiedId, members: ConversationMember[]): Promise<void> {
    this.deps.memberCache.addMembers(conversationId as QualifiedId, members.map((m) => ({
      userId: m.userId as QualifiedId,
      role: (m.role === "wire_admin" ? "admin" : "member") as CachedMember["role"],
    })));
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
    this.personalModeCache.set(channelId, isPersonalMode);
    try {
      const existing = await this.deps.channelConfig.get(channelId);
      if (existing) await this.deps.channelConfig.upsert({ ...existing, isPersonalMode });
    } catch { /* non-fatal */ }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command matchers
  // ─────────────────────────────────────────────────────────────────────────

  private startsWithJeeves(lowered: string): boolean {
    return lowered.startsWith("jeeves") || lowered.startsWith("@jeeves");
  }

  private stripJeevesPrefix(lowered: string): string {
    return lowered.replace(/^@?jeeves[,:]?\s*/i, "").trim();
  }

  private matchesPauseCommand(lowered: string): boolean {
    const s = this.stripJeevesPrefix(lowered);
    return /^(pause|step out)$/.test(s) || /^(pause|step out)$/.test(lowered);
  }

  private matchesResumeCommand(lowered: string): boolean {
    const s = this.stripJeevesPrefix(lowered);
    return /^(resume|come back)$/.test(s) || /^(resume|come back)$/.test(lowered);
  }

  private matchesSecureCommand(lowered: string): boolean {
    const s = this.stripJeevesPrefix(lowered);
    return /^(secure mode|ears off|secure)$/.test(s) || /^(secure mode|ears off)$/.test(lowered);
  }

  private matchContextCommand(text: string): ContextCommandMatch | null {
    const m = (re: RegExp, field: ContextField) => { const r = text.match(re); return r ? { field, value: r[1].trim() } : null; };
    return m(/^@?[Jj]eeves[,:]?\s+context:\s*(.+)$/i, "purpose")
      ?? m(/^@?[Jj]eeves[,:]?\s+context\s+type:\s*(.+)$/i, "type")
      ?? m(/^@?[Jj]eeves[,:]?\s+context\s+tags:\s*(.+)$/i, "tags")
      ?? m(/^@?[Jj]eeves[,:]?\s+context\s+stakeholders:\s*(.+)$/i, "stakeholders")
      ?? m(/^@?[Jj]eeves[,:]?\s+context\s+related:\s*(.+)$/i, "related")
      ?? null;
  }

}

type ContextField = "purpose" | "type" | "tags" | "stakeholders" | "related";
interface ContextCommandMatch { field: ContextField; value: string; }
