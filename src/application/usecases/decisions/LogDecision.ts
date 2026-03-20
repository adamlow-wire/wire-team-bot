import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { Decision, DecisionContextItem } from "../../../domain/entities/Decision";
import type { DecisionRepository } from "../../../domain/repositories/DecisionRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { BufferedMessage } from "../../services/ConversationMessageBuffer";
import type { Logger } from "../../ports/Logger";
import type { StoreKnowledge } from "../knowledge/StoreKnowledge";

export interface LogDecisionInput {
  conversationId: QualifiedId;
  authorId: QualifiedId;
  authorName: string;
  rawMessageId: string;
  rawMessage: string;
  summary: string;
  contextMessages: BufferedMessage[];
  participantIds: QualifiedId[];
}

export class LogDecision {
  constructor(
    private readonly decisions: DecisionRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger: Logger,
    private readonly storeKnowledge?: StoreKnowledge,
  ) {}

  async execute(input: LogDecisionInput): Promise<Decision> {
    const now = new Date();
    const id = await this.decisions.nextId();

    const context: DecisionContextItem[] = input.contextMessages.map((m) => ({
      userId: m.senderId,
      userName: m.senderName,
      messageText: m.text,
      messageId: m.messageId,
      timestamp: m.timestamp,
    }));

    const decision: Decision = {
      id,
      summary: input.summary,
      rawMessage: input.rawMessage,
      rawMessageId: input.rawMessageId,
      context,
      authorId: input.authorId,
      authorName: input.authorName,
      participants: input.participantIds,
      conversationId: input.conversationId,
      status: "active",
      linkedIds: [],
      attachments: [],
      tags: [],
      timestamp: now,
      updatedAt: now,
      deleted: false,
      version: 1,
    };

    const saved = await this.decisions.create(decision);
    this.logger.info("Decision logged", { decisionId: saved.id, conversationId: input.conversationId.id });

    await this.auditLog.append({
      timestamp: now,
      actorId: input.authorId,
      conversationId: input.conversationId,
      action: "entity_created",
      entityType: "Decision",
      entityId: saved.id,
      details: { summary: saved.summary },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `Decision **${saved.id}** logged: ${saved.summary}`,
      { replyToMessageId: input.rawMessageId },
    );

    await this.wireOutbound.sendCompositePrompt(
      input.conversationId,
      "Any actions from this?",
      [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      { replyToMessageId: input.rawMessageId },
    );

    // Mirror the decision into the knowledge base so it is discoverable
    // via semantic search ("what did we decide about X?").
    if (this.storeKnowledge) {
      void this.storeKnowledge.execute({
        conversationId: input.conversationId,
        authorId: input.authorId,
        authorName: input.authorName,
        rawMessageId: input.rawMessageId,
        rawMessage: input.rawMessage,
        summary: `[${saved.id}] ${saved.summary}`,
        detail: input.rawMessage,
        category: "procedural",
        confidence: "high",
        ttlDays: null,
        silent: true,
      }).catch((err: unknown) => {
        this.logger.warn("Failed to mirror decision to KB", { decisionId: saved.id, err: String(err) });
      });
    }

    return saved;
  }
}
