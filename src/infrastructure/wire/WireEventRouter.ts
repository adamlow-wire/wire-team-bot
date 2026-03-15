import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { Conversation, ConversationMember, TextMessage, ButtonActionMessage } from "wire-apps-js-sdk";
import { WireEventsHandler, ButtonActionConfirmationMessage } from "wire-apps-js-sdk";
import type { CreateTaskFromExplicit } from "../../application/usecases/tasks/CreateTaskFromExplicit";
import type { UpdateTaskStatus } from "../../application/usecases/tasks/UpdateTaskStatus";
import type { ListMyTasks } from "../../application/usecases/tasks/ListMyTasks";
import type { LogDecision } from "../../application/usecases/decisions/LogDecision";
import type { CreateActionFromExplicit } from "../../application/usecases/actions/CreateActionFromExplicit";
import type { UpdateActionStatus } from "../../application/usecases/actions/UpdateActionStatus";
import type { ListMyActions } from "../../application/usecases/actions/ListMyActions";
import type { ListTeamActions } from "../../application/usecases/actions/ListTeamActions";
import type { ReassignAction } from "../../application/usecases/actions/ReassignAction";
import type { SearchDecisions } from "../../application/usecases/decisions/SearchDecisions";
import type { ListDecisions } from "../../application/usecases/decisions/ListDecisions";
import type { SupersedeDecision } from "../../application/usecases/decisions/SupersedeDecision";
import type { RevokeDecision } from "../../application/usecases/decisions/RevokeDecision";
import type { CreateReminder } from "../../application/usecases/reminders/CreateReminder";
import type { StoreKnowledge } from "../../application/usecases/knowledge/StoreKnowledge";
import type { RetrieveKnowledge } from "../../application/usecases/knowledge/RetrieveKnowledge";
import type { ConversationMessageBuffer } from "../../application/services/ConversationMessageBuffer";
import type { DateTimeService } from "../../domain/services/DateTimeService";
import type { ConversationMemberCache, CachedMember } from "../../domain/services/ConversationMemberCache";
import type { ConversationConfigRepository } from "../../domain/repositories/ConversationConfigRepository";
import type { ImplicitDetectionService } from "../../domain/services/ImplicitDetectionService";
import type { WireOutboundPort } from "../../application/ports/WireOutboundPort";
import type { Logger } from "../../application/ports/Logger";

const CONTEXT_WINDOW = 10;
const IMPLICIT_RATE_LIMIT_MS = 60_000;
const IMPLICIT_KNOWLEDGE_MIN_CONFIDENCE = 0.7;

function toCachedMembers(members: ConversationMember[]): CachedMember[] {
  return members.map((m) => ({
    userId: m.userId as QualifiedId,
    role: (m.role === "wire_admin" ? "admin" : "member") as CachedMember["role"],
  }));
}

export interface WireEventRouterDeps {
  logger: Logger;
  createTaskFromExplicit: CreateTaskFromExplicit;
  updateTaskStatus: UpdateTaskStatus;
  listMyTasks: ListMyTasks;
  logDecision: LogDecision;
  searchDecisions: SearchDecisions;
  listDecisions: ListDecisions;
  supersedeDecision: SupersedeDecision;
  revokeDecision: RevokeDecision;
  createActionFromExplicit: CreateActionFromExplicit;
  updateActionStatus: UpdateActionStatus;
  listMyActions: ListMyActions;
  listTeamActions: ListTeamActions;
  reassignAction: ReassignAction;
  createReminder: CreateReminder;
  storeKnowledge: StoreKnowledge;
  retrieveKnowledge: RetrieveKnowledge;
  implicitDetection: ImplicitDetectionService;
  wireOutbound: WireOutboundPort;
  messageBuffer: ConversationMessageBuffer;
  dateTimeService: DateTimeService;
  memberCache: ConversationMemberCache;
  conversationConfig: ConversationConfigRepository;
}

/**
 * Maps Wire SDK events to application use cases. Handles explicit triggers and Phase 3 implicit detection.
 */
interface PendingKnowledgeConfirmation {
  summary: string;
  detail: string;
  authorId: QualifiedId;
  rawMessageId: string;
  rawMessage: string;
}

export class WireEventRouter extends WireEventsHandler {
  private readonly implicitLastRunByConv = new Map<string, number>();
  /** Keyed by `convId.id@convId.domain`, holds the most recent implicit knowledge candidate awaiting confirmation. */
  private readonly pendingKnowledge = new Map<string, PendingKnowledgeConfirmation>();

  constructor(private readonly deps: WireEventRouterDeps) {
    super();
  }

  async onTextMessageReceived(wireMessage: TextMessage): Promise<void> {
    const text = wireMessage.text ?? "";
    const convId = wireMessage.conversationId as QualifiedId;
    const sender = wireMessage.sender as QualifiedId;
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

    try {
      await this.handleTextMessage(wireMessage, text, convId, sender, log);
    } catch (err) {
      log.error("Handler failed", { err: String(err), stack: err instanceof Error ? err.stack : undefined });
      try {
        await this.deps.wireOutbound.sendPlainText(
          convId,
          "Something went wrong. Please try again.",
          { replyToMessageId: wireMessage.id },
        );
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
    log: Logger,
  ): Promise<void> {
    const lowered = text.trim().toLowerCase();

    // Check TASK-NNNN status updates BEFORE the generic "task" prefix check so that
    // "TASK-0001 done" is not accidentally routed to task creation (both start with "task").
    const taskDoneMatch = text.match(/^(TASK-\d+)\s+(done|in_progress|cancelled|in progress)\s*(.*)$/i);
    if (taskDoneMatch) {
      const [, taskId, status, note] = taskDoneMatch;
      const norm = status!.toLowerCase().replace(/\s+/g, "_") as "done" | "in_progress" | "cancelled";
      await this.deps.updateTaskStatus.execute({
        taskId: taskId!,
        newStatus: norm,
        conversationId: convId,
        actorId: sender,
        completionNote: note?.trim() || undefined,
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    if (lowered.startsWith("task") || lowered.startsWith("task:")) {
      const rest = text.replace(/^task[:\s]*/i, "").trim();
      if (rest === "my tasks" || rest === "my task" || rest === "list" || rest === "") {
        await this.deps.listMyTasks.execute({
          conversationId: convId,
          assigneeId: sender,
          replyToMessageId: wireMessage.id,
        });
        return;
      }
      const description = rest;
      await this.deps.createTaskFromExplicit.execute({
        conversationId: convId,
        authorId: sender,
        authorName: "",
        rawMessageId: wireMessage.id,
        rawMessage: text,
        description: description || text,
      });
      return;
    }

    if (
      lowered.startsWith("decision:") ||
      lowered.startsWith("decided:") ||
      lowered.startsWith("log decision:")
    ) {
      const summary = text
        .replace(/^decision:\s*/i, "")
        .replace(/^decided:\s*/i, "")
        .replace(/^log decision:\s*/i, "")
        .trim();
      const contextMessages = this.deps.messageBuffer.getLastN(convId, CONTEXT_WINDOW);
      const participantIds =
        contextMessages.length
          ? [...new Map(contextMessages.map((m) => [m.senderId.id, m.senderId])).values()]
          : [sender];
      await this.deps.logDecision.execute({
        conversationId: convId,
        authorId: sender,
        authorName: "",
        rawMessageId: wireMessage.id,
        rawMessage: text,
        summary: summary || text,
        contextMessages,
        participantIds,
      });
      return;
    }

    const decisionsAboutMatch = lowered.match(/^decisions?\s+about\s+(.+)$/);
    if (decisionsAboutMatch) {
      await this.deps.searchDecisions.execute({
        conversationId: convId,
        searchText: decisionsAboutMatch[1].trim(),
        replyToMessageId: wireMessage.id,
      });
      return;
    }
    if (lowered === "list decisions" || lowered === "decisions" || lowered === "decisions list") {
      await this.deps.listDecisions.execute({
        conversationId: convId,
        replyToMessageId: wireMessage.id,
      });
      return;
    }
    const supersedeMatch = text.match(/^decision:\s*(.+?)\s+supersedes\s+(DEC-\d+)\s*$/i);
    if (supersedeMatch) {
      await this.deps.supersedeDecision.execute({
        conversationId: convId,
        authorId: sender,
        authorName: "",
        rawMessageId: wireMessage.id,
        rawMessage: text,
        newSummary: supersedeMatch[1].trim(),
        supersedesDecisionId: supersedeMatch[2],
        replyToMessageId: wireMessage.id,
      });
      return;
    }
    const revokeMatch = text.match(/^revoke\s+(DEC-\d+)\s*(.*)$/i);
    if (revokeMatch) {
      await this.deps.revokeDecision.execute({
        conversationId: convId,
        actorId: sender,
        decisionId: revokeMatch[1],
        reason: revokeMatch[2].trim() || undefined,
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    if (lowered.startsWith("action") || lowered.startsWith("action:")) {
      const rest = text.replace(/^action[:\s]*/i, "").trim();
      if (rest === "my actions" || rest === "my action" || rest === "" || rest === "list") {
        await this.deps.listMyActions.execute({
          conversationId: convId,
          assigneeId: sender,
          replyToMessageId: wireMessage.id,
        });
        return;
      }
      if (rest === "team actions" || rest === "team" || rest === "all") {
        await this.deps.listTeamActions.execute({
          conversationId: convId,
          replyToMessageId: wireMessage.id,
        });
        return;
      }
      let linkedDecisionId: string | undefined;
      const refMatch = rest.match(/\bref\s+(DEC-\d+)\b/i);
      if (refMatch) linkedDecisionId = refMatch[1];
      const description = rest.replace(/\bref\s+DEC-\d+\b/gi, "").trim();
      await this.deps.createActionFromExplicit.execute({
        conversationId: convId,
        creatorId: sender,
        authorName: "",
        rawMessageId: wireMessage.id,
        rawMessage: text,
        description: description || rest,
        linkedDecisionId,
      });
      return;
    }

    const actReassignMatch = text.match(/^(ACT-\d+)\s+reassign\s+to\s+(.+)$/i);
    if (actReassignMatch) {
      await this.deps.reassignAction.execute({
        actionId: actReassignMatch[1],
        conversationId: convId,
        newAssigneeReference: actReassignMatch[2].trim(),
        actorId: sender,
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    const actDoneMatch = text.match(/^(ACT-\d+)\s+(done|cancelled|in progress)\s*(.*)$/i);
    if (actDoneMatch) {
      const [, actionId, status, note] = actDoneMatch;
      await this.deps.updateActionStatus.execute({
        actionId: actionId!,
        newStatus: status!.toLowerCase().replace(" ", "_") as "done" | "cancelled" | "in_progress",
        conversationId: convId,
        actorId: sender,
        completionNote: note?.trim() || undefined,
        replyToMessageId: wireMessage.id,
      });
      return;
    }

    if (
      lowered.startsWith("knowledge:") ||
      lowered.startsWith("remember that") ||
      lowered.startsWith("note:")
    ) {
      const rest = text
        .replace(/^knowledge:\s*/i, "")
        .replace(/^remember that\s+/i, "")
        .replace(/^note:\s*/i, "")
        .trim();
      if (rest.length > 0) {
        await this.deps.storeKnowledge.execute({
          conversationId: convId,
          authorId: sender,
          authorName: "",
          rawMessageId: wireMessage.id,
          rawMessage: text,
          summary: rest.length > 120 ? `${rest.slice(0, 117)}…` : rest,
          detail: rest,
        });
        return;
      }
    }

    // Longer alternatives must come first so "what is" isn't shadowed by "what" (what'?s? matches "what" alone).
    const whatMatch = lowered.match(/^(what is|how do we|how do i|what'?s?)\s+(.+)$/);
    if (whatMatch) {
      const query = whatMatch[2].trim().replace(/\?+$/, "");
      if (query.length > 0) {
        await this.deps.retrieveKnowledge.execute({
          conversationId: convId,
          query,
          replyToMessageId: wireMessage.id,
        });
        return;
      }
    }

    if (lowered.startsWith("reminder") || lowered.startsWith("remind me")) {
      const rest = text.replace(/^reminder[:\s]*/i, "").replace(/^remind me\s*/i, "").trim();
      const config = await this.deps.conversationConfig.get(convId);
      const timezone = config?.timezone ?? "UTC";
      const atMatch = rest.match(/at\s+(.+)$/i);
      const inMatch = rest.match(/in\s+(.+?)\s+(.+)$/i);
      let triggerAt: Date | null = null;
      let description = rest;
      if (atMatch) {
        const parsed = this.deps.dateTimeService.parse(atMatch[1].trim(), { timezone });
        if (parsed?.value) {
          triggerAt = parsed.value;
          description = rest.replace(/at\s+.+$/i, "").trim() || "Reminder";
        }
      } else if (inMatch) {
        const parsed = this.deps.dateTimeService.parse(inMatch[1].trim(), { timezone });
        if (parsed?.value) {
          triggerAt = parsed.value;
          description = inMatch[2].trim() || "Reminder";
        }
      }
      if (!triggerAt) {
        await this.deps.wireOutbound.sendPlainText(
          convId,
          "Sorry, I couldn't parse that time. Try: \"remind me at 3pm to call John\" or \"reminder in 2 hours check the build\".",
          { replyToMessageId: wireMessage.id },
        );
        return;
      }
      await this.deps.createReminder.execute({
        conversationId: convId,
        authorId: sender,
        authorName: "",
        rawMessageId: wireMessage.id,
        rawMessage: text,
        description: description || "Reminder",
        targetId: sender,
        triggerAt,
      });
      return;
    }

    const config = await this.deps.conversationConfig.get(convId);
    if (config?.implicitDetectionEnabled !== false) {
      const convKey = `${convId.id}@${convId.domain}`;
      const now = Date.now();
      const last = this.implicitLastRunByConv.get(convKey) ?? 0;
      if (now - last >= IMPLICIT_RATE_LIMIT_MS) {
        this.implicitLastRunByConv.set(convKey, now);
        const recent = this.deps.messageBuffer.getLastN(convId, CONTEXT_WINDOW);
        const sensitivity = config?.sensitivity ?? "normal";
        try {
          const candidates = await this.deps.implicitDetection.detect({
            conversationId: convId,
            recentMessages: recent.map((m) => ({
              senderId: m.senderId,
              text: m.text,
              messageId: m.messageId,
            })),
            sensitivity,
          });
          const knowledgeCandidate = candidates.find(
            (c) => c.type === "knowledge" && c.confidence >= IMPLICIT_KNOWLEDGE_MIN_CONFIDENCE,
          );
          if (knowledgeCandidate) {
            const payload = knowledgeCandidate.payload as Record<string, unknown>;
            const summary = (payload?.summary as string | undefined) ?? knowledgeCandidate.summary;
            const detail = (payload?.detail as string | undefined) ?? summary;
            const display = summary?.slice(0, 150) ?? knowledgeCandidate.summary;
            const convKey = `${convId.id}@${convId.domain}`;
            this.pendingKnowledge.set(convKey, {
              summary,
              detail,
              authorId: sender,
              rawMessageId: wireMessage.id,
              rawMessage: text,
            });
            await this.deps.wireOutbound.sendCompositePrompt(
              convId,
              `Shall I remember that?\n> ${display}`,
              [{ id: "confirm_knowledge", label: "Confirm" }, { id: "dismiss", label: "Dismiss" }],
              { replyToMessageId: wireMessage.id },
            );
            return;
          }
        } catch (err) {
          log.warn("Implicit detection failed", { err: String(err) });
        }
      }
    }
  }

  async onAppAddedToConversation(
    conversation: Conversation,
    members: ConversationMember[],
  ): Promise<void> {
    const convId = { id: conversation.id, domain: conversation.domain } as QualifiedId;
    this.deps.memberCache.setMembers(convId, toCachedMembers(members));
  }

  async onConversationDeleted(conversationId: QualifiedId): Promise<void> {
    this.deps.memberCache.clearConversation(conversationId as QualifiedId);
  }

  async onUserJoinedConversation(
    conversationId: QualifiedId,
    members: ConversationMember[],
  ): Promise<void> {
    // Use addMembers (merge) not setMembers (replace): the SDK join event
    // delivers only the newly-joined members, not the full conversation roster.
    this.deps.memberCache.addMembers(conversationId as QualifiedId, toCachedMembers(members));
  }

  async onUserLeftConversation(
    conversationId: QualifiedId,
    members: QualifiedId[],
  ): Promise<void> {
    this.deps.memberCache.removeMembers(conversationId as QualifiedId, members as QualifiedId[]);
  }

  /**
   * Handles interactive button presses from composite prompts.
   * Handles:
   *  - "confirm_knowledge" / "dismiss": from implicit detection "Shall I remember that?" prompt.
   *  - "yes" / "no": from post-decision "Any actions from this?" prompt.
   * Sends a ButtonActionConfirmationMessage back so the client marks the button as selected.
   */
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
          try {
            await this.deps.storeKnowledge.execute({
              conversationId: convId,
              authorId: pending.authorId,
              authorName: "",
              rawMessageId: pending.rawMessageId,
              rawMessage: pending.rawMessage,
              summary: pending.summary,
              detail: pending.detail,
            });
          } catch (err) {
            log.error("Failed to store confirmed knowledge", { err: String(err) });
          }
        }
        break;
      }
      case "dismiss":
        this.pendingKnowledge.delete(convKey);
        break;
      case "yes":
        // "Any actions from this?" — acknowledged. The user should follow up with an explicit "action:" command.
        await this.deps.wireOutbound.sendPlainText(convId, "Use \"action: <description>\" to log the action.");
        break;
      case "no":
        // Acknowledged; nothing to do.
        break;
      default:
        log.warn("Unhandled button action", { buttonId });
    }

    // Acknowledge the button press so the sender sees their selection confirmed.
    try {
      await this.manager.sendMessage(
        ButtonActionConfirmationMessage.create({ conversationId: convId, referenceMessageId, buttonId }),
      );
    } catch {
      // manager not available in tests or before SDK initialisation — safe to ignore
    }
  }
}
