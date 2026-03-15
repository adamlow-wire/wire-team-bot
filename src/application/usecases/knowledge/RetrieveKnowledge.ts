import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { KnowledgeRepository } from "../../../domain/repositories/KnowledgeRepository";
import type { SearchService } from "../../../domain/services/SearchService";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";

export interface RetrieveKnowledgeInput {
  conversationId: QualifiedId;
  query: string;
  conversationIds?: QualifiedId[];
  limit?: number;
  replyToMessageId?: string;
}

export class RetrieveKnowledge {
  constructor(
    private readonly searchService: SearchService,
    private readonly knowledge: KnowledgeRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: RetrieveKnowledgeInput): Promise<void> {
    const limit = input.limit ?? 5;
    const hits = await this.searchService.searchKnowledge({
      query: input.query,
      conversationIds: input.conversationIds ?? [input.conversationId],
      limit,
    });

    if (hits.length === 0) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        "I don't have anything on that. If someone answers, I can capture it.",
        { replyToMessageId: input.replyToMessageId },
      );
      return;
    }

    const lines = hits.map(
      (h) =>
        `• ${h.id}: ${h.summary} (${h.confidence}, updated ${h.updatedAt.toISOString().slice(0, 10)})\n  ${h.detail.slice(0, 200)}${h.detail.length > 200 ? "…" : ""}`,
    );
    await this.wireOutbound.sendPlainText(
      input.conversationId,
      lines.join("\n\n"),
      { replyToMessageId: input.replyToMessageId },
    );

    for (const h of hits) {
      await this.knowledge.incrementRetrievalCount(h.id);
    }
  }
}
