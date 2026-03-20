export interface KnowledgeContext {
  id: string;
  summary: string;
  detail: string;
  confidence: string;
  updatedAt: Date;
}

export interface ConversationMemberContext {
  id: string;
  name?: string;
}

export interface GeneralAnswerService {
  answer(
    question: string,
    conversationContext: string[],
    knowledgeContext: KnowledgeContext[],
    members?: ConversationMemberContext[],
    conversationPurpose?: string,
  ): Promise<string>;
}
