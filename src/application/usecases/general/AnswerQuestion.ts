import type { GeneralAnswerService, KnowledgeContext, ConversationMemberContext } from "../../ports/GeneralAnswerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { SearchService } from "../../../domain/services/SearchService";
import type { KnowledgeRepository } from "../../../domain/repositories/KnowledgeRepository";

export interface AnswerQuestionInput {
  question: string;
  conversationContext: string[];
  conversationId: QualifiedId;
  replyToMessageId: string;
  members?: ConversationMemberContext[];
  conversationPurpose?: string;
}

export class AnswerQuestion {
  constructor(
    private readonly generalAnswer: GeneralAnswerService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly searchService: SearchService,
    private readonly knowledgeRepo: KnowledgeRepository,
  ) {}

  async execute(input: AnswerQuestionInput): Promise<void> {
    const hits = await this.searchService.searchKnowledge({
      query: input.question,
      conversationIds: [input.conversationId],
      limit: 5,
    });

    const knowledgeContext: KnowledgeContext[] = hits.map((h) => ({
      id: h.id,
      summary: h.summary,
      detail: h.detail,
      confidence: h.confidence,
      updatedAt: h.updatedAt,
    }));

    const answer = await this.generalAnswer.answer(
      input.question,
      input.conversationContext,
      knowledgeContext,
      input.members,
      input.conversationPurpose,
    );

    await this.wireOutbound.sendPlainText(input.conversationId, answer, {
      replyToMessageId: input.replyToMessageId,
    });

    for (const h of hits) {
      await this.knowledgeRepo.incrementRetrievalCount(h.id);
    }
  }
}
