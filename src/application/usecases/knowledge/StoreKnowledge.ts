import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { KnowledgeEntry, KnowledgeCategory, KnowledgeConfidence } from "../../../domain/entities/KnowledgeEntry";
import type { KnowledgeRepository } from "../../../domain/repositories/KnowledgeRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { Logger } from "../../ports/Logger";
import type { EmbeddingService } from "../../ports/EmbeddingPort";

export interface StoreKnowledgeInput {
  conversationId: QualifiedId;
  authorId: QualifiedId;
  authorName: string;
  rawMessageId: string;
  rawMessage: string;
  summary: string;
  detail: string;
  category?: KnowledgeCategory;
  confidence?: KnowledgeConfidence;
  tags?: string[];
  ttlDays?: number | null;
  /** When true, skip outbound confirmation messages — used for internal mirroring (e.g. decisions). */
  silent?: boolean;
}

export class StoreKnowledge {
  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger: Logger,
    private readonly embeddingService?: EmbeddingService,
  ) {}

  async execute(input: StoreKnowledgeInput): Promise<KnowledgeEntry> {
    const now = new Date();
    const id = await this.knowledge.nextId();
    const category = input.category ?? "factual";
    const confidence = input.confidence ?? "high";
    const tags = input.tags ?? [];

    const entry: KnowledgeEntry = {
      id,
      summary: input.summary,
      detail: input.detail,
      rawMessage: input.rawMessage,
      rawMessageId: input.rawMessageId,
      authorId: input.authorId,
      authorName: input.authorName,
      conversationId: input.conversationId,
      category,
      confidence,
      relatedIds: [],
      ttlDays: input.ttlDays ?? 90,
      verifiedBy: [],
      retrievalCount: 0,
      lastRetrieved: null,
      tags,
      timestamp: now,
      updatedAt: now,
      deleted: false,
      version: 1,
    };

    const saved = await this.knowledge.create(entry);
    this.logger.info("Knowledge stored", { knowledgeId: saved.id, conversationId: input.conversationId.id, summary: saved.summary.slice(0, 80) });

    // Fire-and-forget: generate and persist the embedding asynchronously so the
    // store acknowledgement is sent to the user without waiting for the LLM call.
    if (this.embeddingService) {
      const embText = `${saved.summary}. ${saved.detail}`;
      void this.embeddingService.embed(embText).then((embedding) => {
        if (embedding) return this.knowledge.updateEmbedding(saved.id, embedding);
      }).catch((err: unknown) => {
        this.logger.warn("Failed to generate embedding for knowledge entry", { id: saved.id, err: String(err) });
      });
    }

    await this.auditLog.append({
      timestamp: now,
      actorId: input.authorId,
      conversationId: input.conversationId,
      action: "entity_created",
      entityType: "KnowledgeEntry",
      entityId: saved.id,
      details: { summary: saved.summary },
    });

    if (!input.silent) {
      const tagPart = saved.tags.length > 0 ? ` — _tags: ${saved.tags.join(", ")}_` : "";
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        `Stored as **${saved.id}**: ${saved.summary}${tagPart}`,
        { replyToMessageId: input.rawMessageId },
      );
      await this.wireOutbound.sendReaction(input.conversationId, input.rawMessageId, "✓");
    }

    return saved;
  }
}
