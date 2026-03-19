export interface KnowledgeContext {
  id: string;
  summary: string;
  detail: string;
  confidence: string;
  updatedAt: Date;
}

export interface GeneralAnswerService {
  answer(question: string, conversationContext: string[], knowledgeContext: KnowledgeContext[]): Promise<string>;
}
