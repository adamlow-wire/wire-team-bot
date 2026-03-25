import type { Decision } from "../../../domain/entities/Decision";
import type { DecisionRepository } from "../../../domain/repositories/DecisionRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface SupersedeDecisionInput {
  newSummary: string;
  supersedesDecisionId: string;
  conversationId: QualifiedId;
  authorId: QualifiedId;
  authorName: string;
  rawMessageId: string;
  replyToMessageId?: string;
}

export class SupersedeDecision {
  constructor(
    private readonly decisions: DecisionRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: SupersedeDecisionInput): Promise<Decision | null> {
    const oldDecision = await this.decisions.findById(input.supersedesDecisionId);
    if (!oldDecision || oldDecision.conversationId.id !== input.conversationId.id) {
      return null;
    }

    const now = new Date();
    const newId = await this.decisions.nextId();

    const newDecision: Decision = {
      id: newId,
      summary: input.newSummary,
      rawMessageId: input.rawMessageId,
      context: [],
      authorId: input.authorId,
      authorName: input.authorName,
      participants: [],
      conversationId: input.conversationId,
      status: "active",
      supersededBy: null,
      supersedes: input.supersedesDecisionId,
      linkedIds: oldDecision.linkedIds,
      attachments: [],
      tags: [],
      timestamp: now,
      updatedAt: now,
      deleted: false,
      version: 1,
    };

    await this.decisions.create(newDecision);

    const updatedOld: Decision = {
      ...oldDecision,
      status: "superseded",
      supersededBy: newId,
      updatedAt: now,
      version: oldDecision.version + 1,
    };
    await this.decisions.update(updatedOld);

    await this.auditLog.append({
      timestamp: now,
      actorId: input.authorId,
      conversationId: input.conversationId,
      action: "entity_created",
      entityType: "Decision",
      entityId: newId,
      details: { supersedes: input.supersedesDecisionId },
    });
    await this.auditLog.append({
      timestamp: now,
      actorId: input.authorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Decision",
      entityId: input.supersedesDecisionId,
      details: { supersededBy: newId },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `Decision **${newId}** logged _(supersedes ${input.supersedesDecisionId})_: ${input.newSummary}`,
      { replyToMessageId: input.replyToMessageId },
    );

    return newDecision;
  }
}
