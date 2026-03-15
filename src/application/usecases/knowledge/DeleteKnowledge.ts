import type { KnowledgeEntry } from "../../../domain/entities/KnowledgeEntry";
import type { KnowledgeRepository } from "../../../domain/repositories/KnowledgeRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface DeleteKnowledgeInput {
  knowledgeId: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  replyToMessageId?: string;
}

export class DeleteKnowledge {
  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: DeleteKnowledgeInput): Promise<KnowledgeEntry | null> {
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
      deleted: true,
      updatedAt: new Date(),
      version: entry.version + 1,
    };

    await this.knowledge.update(updated);

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_deleted",
      entityType: "KnowledgeEntry",
      entityId: entry.id,
      details: {},
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `**${entry.id}** forgotten.`,
      { replyToMessageId: input.replyToMessageId },
    );

    return updated;
  }
}
