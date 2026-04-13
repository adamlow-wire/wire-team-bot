/**
 * IntentToolExecutor — maps classified intents to use-case invocations.
 *
 * For structured ID references (ACT-NNNN, DEC-NNNN, REM-NNNN) the value is
 * passed directly to the use-case.  For natural-language references the
 * executor searches the relevant repository and resolves to an ID, sending
 * a disambiguation message if multiple matches are found.
 */

import type { Intent } from "../../domain/schemas/intent";
import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { LogDecision } from "../usecases/decisions/LogDecision";
import type { CreateActionFromExplicit } from "../usecases/actions/CreateActionFromExplicit";
import type { UpdateActionStatus } from "../usecases/actions/UpdateActionStatus";
import type { ReassignAction } from "../usecases/actions/ReassignAction";
import type { UpdateActionDeadline } from "../usecases/actions/UpdateActionDeadline";
import type { ListMyActions } from "../usecases/actions/ListMyActions";
import type { ListTeamActions } from "../usecases/actions/ListTeamActions";
import type { ListOverdueActions } from "../usecases/actions/ListOverdueActions";
import type { SearchDecisions } from "../usecases/decisions/SearchDecisions";
import type { ListDecisions } from "../usecases/decisions/ListDecisions";
import type { SupersedeDecision } from "../usecases/decisions/SupersedeDecision";
import type { RevokeDecision } from "../usecases/decisions/RevokeDecision";
import type { CreateReminder } from "../usecases/reminders/CreateReminder";
import type { ListMyReminders } from "../usecases/reminders/ListMyReminders";
import type { CancelReminder } from "../usecases/reminders/CancelReminder";
import type { SnoozeReminder } from "../usecases/reminders/SnoozeReminder";
import type { WireOutboundPort } from "../ports/WireOutboundPort";
import type { ActionRepository } from "../../domain/repositories/ActionRepository";
import type { DecisionRepository } from "../../domain/repositories/DecisionRepository";
import type { ReminderRepository } from "../../domain/repositories/ReminderRepository";
import type { ConversationConfigRepository } from "../../domain/repositories/ConversationConfigRepository";
import type { DateTimeService } from "../../domain/services/DateTimeService";
import type { BufferedMessage, ConversationMessageBuffer } from "./ConversationMessageBuffer";

export interface ToolExecutionContext {
  conversationId: QualifiedId;
  channelId: string;
  sender: QualifiedId;
  senderName: string | undefined;
  replyToMessageId: string;
  members: Array<{ id: string; domain: string; name: string | undefined }>;
  timezone: string;
}

export interface IntentToolExecutorDeps {
  logDecision: LogDecision;
  createActionFromExplicit: CreateActionFromExplicit;
  updateActionStatus: UpdateActionStatus;
  reassignAction: ReassignAction;
  updateActionDeadline: UpdateActionDeadline;
  listMyActions: ListMyActions;
  listTeamActions: ListTeamActions;
  listOverdueActions: ListOverdueActions;
  searchDecisions: SearchDecisions;
  listDecisions: ListDecisions;
  supersedeDecision: SupersedeDecision;
  revokeDecision: RevokeDecision;
  createReminder: CreateReminder;
  listMyReminders: ListMyReminders;
  cancelReminder: CancelReminder;
  snoozeReminder: SnoozeReminder;
  wireOutbound: WireOutboundPort;
  actionRepo: ActionRepository;
  decisionRepo: DecisionRepository;
  reminderRepo: ReminderRepository;
  conversationConfig: ConversationConfigRepository;
  dateTimeService: DateTimeService;
  messageBuffer: ConversationMessageBuffer;
}

const ACT_RE = /^ACT-\d+$/i;
const DEC_RE = /^DEC-\d+$/i;
const REM_RE = /^REM-\d+$/i;

export class IntentToolExecutor {
  constructor(private readonly deps: IntentToolExecutorDeps) {}

  /**
   * Execute the given intent in the provided context.
   * Returns true if the intent was handled, false if it was "unknown"
   * (caller should fall back to answerQuestion).
   */
  async execute(intent: Intent, ctx: ToolExecutionContext): Promise<boolean> {
    switch (intent.type) {
      case "create_decision":
        return this.handleCreateDecision(intent.params, ctx);
      case "create_action":
        return this.handleCreateAction(intent.params, ctx);
      case "supersede_decision":
        return this.handleSupersedeDecision(intent.params, ctx);
      case "revoke_decision":
        return this.handleRevokeDecision(intent.params, ctx);
      case "update_action_status":
        return this.handleUpdateActionStatus(intent.params, ctx);
      case "reassign_action":
        return this.handleReassignAction(intent.params, ctx);
      case "update_action_deadline":
        return this.handleUpdateActionDeadline(intent.params, ctx);
      case "set_reminder":
        return this.handleSetReminder(intent.params, ctx);
      case "cancel_reminder":
        return this.handleCancelReminder(intent.params, ctx);
      case "snooze_reminder":
        return this.handleSnoozeReminder(intent.params, ctx);
      case "list_my_actions":
        await this.deps.listMyActions.execute({
          conversationId: ctx.conversationId,
          assigneeId: ctx.sender,
          replyToMessageId: ctx.replyToMessageId,
        });
        return true;
      case "list_team_actions":
        await this.deps.listTeamActions.execute({
          conversationId: ctx.conversationId,
          replyToMessageId: ctx.replyToMessageId,
        });
        return true;
      case "list_overdue_actions":
        await this.deps.listOverdueActions.execute({
          conversationId: ctx.conversationId,
          replyToMessageId: ctx.replyToMessageId,
        });
        return true;
      case "list_decisions":
        await this.deps.listDecisions.execute({
          conversationId: ctx.conversationId,
          replyToMessageId: ctx.replyToMessageId,
        });
        return true;
      case "search_decisions":
        await this.deps.searchDecisions.execute({
          conversationId: ctx.conversationId,
          searchText: intent.params.query,
          replyToMessageId: ctx.replyToMessageId,
        });
        return true;
      case "list_my_reminders":
        await this.deps.listMyReminders.execute({
          conversationId: ctx.conversationId,
          targetId: ctx.sender,
          replyToMessageId: ctx.replyToMessageId,
        });
        return true;
      case "unknown":
        return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Write intent handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleCreateDecision(
    params: { summary: string; supersedesRef?: string },
    ctx: ToolExecutionContext,
  ): Promise<true> {
    const contextMessages = this.deps.messageBuffer.getLastN(ctx.conversationId, 10) as BufferedMessage[];
    const participantIds = contextMessages.length
      ? [...new Map(contextMessages.map((m) => [m.senderId.id, m.senderId])).values()]
      : [ctx.sender];

    if (params.supersedesRef) {
      // Route through supersedeDecision if a reference was provided
      const oldId = await this.resolveDecisionRef(params.supersedesRef, ctx);
      if (oldId) {
        await this.deps.supersedeDecision.execute({
          conversationId: ctx.conversationId,
          authorId: ctx.sender,
          authorName: ctx.senderName ?? "",
          rawMessageId: ctx.replyToMessageId,
          newSummary: params.summary,
          supersedesDecisionId: oldId,
          replyToMessageId: ctx.replyToMessageId,
        });
        return true;
      }
      // If ref not found, fall through and create without supersession
    }

    await this.deps.logDecision.execute({
      conversationId: ctx.conversationId,
      authorId: ctx.sender,
      authorName: ctx.senderName ?? "",
      rawMessageId: ctx.replyToMessageId,
      summary: params.summary,
      contextMessages,
      participantIds,
    });
    return true;
  }

  private async handleCreateAction(
    params: { description: string; assigneeRef?: string },
    ctx: ToolExecutionContext,
  ): Promise<true> {
    const senderName = ctx.senderName ?? "";
    let assigneeReference: string | undefined = params.assigneeRef;

    // Resolve "me" → sender display name
    if (assigneeReference?.toLowerCase() === "me") {
      assigneeReference = senderName || undefined;
    }

    await this.deps.createActionFromExplicit.execute({
      conversationId: ctx.conversationId,
      creatorId: ctx.sender,
      authorName: senderName,
      rawMessageId: ctx.replyToMessageId,
      description: params.description,
      assigneeReference,
    });
    return true;
  }

  private async handleSupersedeDecision(
    params: { newSummary: string; supersedesRef: string },
    ctx: ToolExecutionContext,
  ): Promise<true> {
    const oldId = await this.resolveDecisionRef(params.supersedesRef, ctx);
    if (!oldId) return true; // error message already sent by resolveDecisionRef

    await this.deps.supersedeDecision.execute({
      conversationId: ctx.conversationId,
      authorId: ctx.sender,
      authorName: ctx.senderName ?? "",
      rawMessageId: ctx.replyToMessageId,
      newSummary: params.newSummary,
      supersedesDecisionId: oldId,
      replyToMessageId: ctx.replyToMessageId,
    });
    return true;
  }

  private async handleRevokeDecision(
    params: { targetRef: string; reason?: string },
    ctx: ToolExecutionContext,
  ): Promise<true> {
    const id = await this.resolveDecisionRef(params.targetRef, ctx);
    if (!id) return true;

    await this.deps.revokeDecision.execute({
      decisionId: id,
      conversationId: ctx.conversationId,
      actorId: ctx.sender,
      reason: params.reason,
      replyToMessageId: ctx.replyToMessageId,
    });
    return true;
  }

  private async handleUpdateActionStatus(
    params: { targetRef: string; status: "done" | "cancelled" | "in_progress"; note?: string },
    ctx: ToolExecutionContext,
  ): Promise<true> {
    const id = await this.resolveActionRef(params.targetRef, ctx);
    if (!id) return true;

    await this.deps.updateActionStatus.execute({
      actionId: id,
      newStatus: params.status,
      conversationId: ctx.conversationId,
      actorId: ctx.sender,
      completionNote: params.note,
      replyToMessageId: ctx.replyToMessageId,
    });
    return true;
  }

  private async handleReassignAction(
    params: { targetRef: string; newAssigneeRef: string },
    ctx: ToolExecutionContext,
  ): Promise<true> {
    const id = await this.resolveActionRef(params.targetRef, ctx);
    if (!id) return true;

    let assigneeRef = params.newAssigneeRef;
    if (assigneeRef.toLowerCase() === "me") assigneeRef = ctx.senderName ?? assigneeRef;

    await this.deps.reassignAction.execute({
      actionId: id,
      conversationId: ctx.conversationId,
      newAssigneeReference: assigneeRef,
      actorId: ctx.sender,
      replyToMessageId: ctx.replyToMessageId,
    });
    return true;
  }

  private async handleUpdateActionDeadline(
    params: { targetRef: string; deadlineExpression: string },
    ctx: ToolExecutionContext,
  ): Promise<true> {
    const id = await this.resolveActionRef(params.targetRef, ctx);
    if (!id) return true;

    await this.deps.updateActionDeadline.execute({
      actionId: id,
      conversationId: ctx.conversationId,
      actorId: ctx.sender,
      deadlineText: params.deadlineExpression,
      timezone: ctx.timezone,
      replyToMessageId: ctx.replyToMessageId,
    });
    return true;
  }

  private async handleSetReminder(
    params: { timeExpression: string; description: string },
    ctx: ToolExecutionContext,
  ): Promise<true> {
    const parsed = this.deps.dateTimeService.parse(params.timeExpression, { timezone: ctx.timezone });
    if (!parsed?.value) {
      await this.deps.wireOutbound.sendPlainText(
        ctx.conversationId,
        `I'm afraid I couldn't parse _"${params.timeExpression}"_ as a time. Try: _"remind me at 3pm to call John"_ or _"remind me in 2 hours to check the build"_.`,
        { replyToMessageId: ctx.replyToMessageId },
      );
      return true;
    }

    await this.deps.createReminder.execute({
      conversationId: ctx.conversationId,
      authorId: ctx.sender,
      authorName: ctx.senderName ?? "",
      rawMessageId: ctx.replyToMessageId,
      description: params.description,
      targetId: ctx.sender,
      triggerAt: parsed.value,
    });
    return true;
  }

  private async handleCancelReminder(
    params: { targetRef: string },
    ctx: ToolExecutionContext,
  ): Promise<true> {
    const id = await this.resolveReminderRef(params.targetRef, ctx);
    if (!id) return true;

    await this.deps.cancelReminder.execute({
      reminderId: id,
      conversationId: ctx.conversationId,
      actorId: ctx.sender,
      replyToMessageId: ctx.replyToMessageId,
    });
    return true;
  }

  private async handleSnoozeReminder(
    params: { targetRef: string; snoozeExpression: string },
    ctx: ToolExecutionContext,
  ): Promise<true> {
    const id = await this.resolveReminderRef(params.targetRef, ctx);
    if (!id) return true;

    await this.deps.snoozeReminder.execute({
      reminderId: id,
      conversationId: ctx.conversationId,
      actorId: ctx.sender,
      snoozeExpression: params.snoozeExpression,
      timezone: ctx.timezone,
      replyToMessageId: ctx.replyToMessageId,
    });
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NL reference resolution helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolves an action reference to an ACT-NNNN ID.
   * Accepts structured IDs directly; searches by description for NL refs.
   * Returns null (and sends an error message) if resolution fails.
   */
  private async resolveActionRef(ref: string, ctx: ToolExecutionContext): Promise<string | null> {
    if (ACT_RE.test(ref)) return ref.toUpperCase();

    try {
      const actions = await this.deps.actionRepo.query({
        conversationId: ctx.conversationId,
        statusIn: ["open", "in_progress"],
        limit: 20,
      });
      const lower = ref.toLowerCase();
      const matches = actions.filter((a) => a.description.toLowerCase().includes(lower));

      if (matches.length === 1) return matches[0].id;

      if (matches.length > 1) {
        const list = matches.slice(0, 5).map((a) => `- **${a.id}** — ${a.description.slice(0, 60)}`).join("\n");
        await this.deps.wireOutbound.sendPlainText(
          ctx.conversationId,
          `I found several matching actions — please specify by ID:\n${list}`,
          { replyToMessageId: ctx.replyToMessageId },
        );
        return null;
      }
    } catch { /* fall through */ }

    await this.deps.wireOutbound.sendPlainText(
      ctx.conversationId,
      `I couldn't find an action matching _"${ref}"_.`,
      { replyToMessageId: ctx.replyToMessageId },
    );
    return null;
  }

  /**
   * Resolves a decision reference to a DEC-NNNN ID.
   */
  private async resolveDecisionRef(ref: string, ctx: ToolExecutionContext): Promise<string | null> {
    if (DEC_RE.test(ref)) return ref.toUpperCase();

    try {
      const decisions = await this.deps.decisionRepo.query({
        conversationId: ctx.conversationId,
        statusIn: ["active"],
        limit: 20,
      });
      const lower = ref.toLowerCase();
      const matches = decisions.filter((d) => d.summary.toLowerCase().includes(lower));

      if (matches.length === 1) return matches[0].id;

      if (matches.length > 1) {
        const list = matches.slice(0, 5).map((d) => `- **${d.id}** — ${d.summary.slice(0, 60)}`).join("\n");
        await this.deps.wireOutbound.sendPlainText(
          ctx.conversationId,
          `I found several matching decisions — please specify by ID:\n${list}`,
          { replyToMessageId: ctx.replyToMessageId },
        );
        return null;
      }
    } catch { /* fall through */ }

    await this.deps.wireOutbound.sendPlainText(
      ctx.conversationId,
      `I couldn't find a decision matching _"${ref}"_.`,
      { replyToMessageId: ctx.replyToMessageId },
    );
    return null;
  }

  /**
   * Resolves a reminder reference to a REM-NNNN ID.
   */
  private async resolveReminderRef(ref: string, ctx: ToolExecutionContext): Promise<string | null> {
    if (REM_RE.test(ref)) return ref.toUpperCase();

    try {
      const reminders = await this.deps.reminderRepo.query({
        conversationId: ctx.conversationId,
        statusIn: ["pending"],
      });
      const lower = ref.toLowerCase();
      const matches = reminders.filter((r) => r.description.toLowerCase().includes(lower));

      if (matches.length === 1) return matches[0].id;

      if (matches.length > 1) {
        const list = matches.slice(0, 5).map((r) => `- **${r.id}** — ${r.description.slice(0, 60)}`).join("\n");
        await this.deps.wireOutbound.sendPlainText(
          ctx.conversationId,
          `I found several matching reminders — please specify by ID:\n${list}`,
          { replyToMessageId: ctx.replyToMessageId },
        );
        return null;
      }
    } catch { /* fall through */ }

    await this.deps.wireOutbound.sendPlainText(
      ctx.conversationId,
      `I couldn't find a reminder matching _"${ref}"_.`,
      { replyToMessageId: ctx.replyToMessageId },
    );
    return null;
  }
}
