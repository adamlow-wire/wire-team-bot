import type { KnowledgeEntry } from "../../../domain/entities/KnowledgeEntry";
import type { KnowledgeRepository } from "../../../domain/repositories/KnowledgeRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface UpdateKnowledgeInput {
  knowledgeId: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  newSummary?: string;
  newDetail?: string;
  replyToMessageId?: string;
}

export class UpdateKnowledge {
  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: UpdateKnowledgeInput): Promise<KnowledgeEntry | null> {
    const entry = await this.knowledge.findById(input.knowledgeId);
    if (
      !entry ||
      entry.conversationId.id !== input.conversationId.id ||
      entry.deleted
    ) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        "KB entry not found.",
        { replyToMessageId: input.replyToMessageId },
      );
      return null;
    }

    const updated: KnowledgeEntry = {
      ...entry,
      summary: input.newSummary ?? entry.summary,
      detail: input.newDetail ?? entry.detail,
      updatedAt: new Date(),
      version: entry.version + 1,
    };

    await this.knowledge.update(updated);

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "KnowledgeEntry",
      entityId: entry.id,
      details: {
        ...(input.newSummary !== undefined && { newSummary: input.newSummary }),
        ...(input.newDetail !== undefined && { newDetail: input.newDetail }),
      },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `**${entry.id}** updated: ${updated.summary}`,
      { replyToMessageId: input.replyToMessageId },
    );

    return updated;
  }
}
