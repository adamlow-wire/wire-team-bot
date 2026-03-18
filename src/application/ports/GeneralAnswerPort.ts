export interface GeneralAnswerService {
  answer(question: string, conversationContext: string[]): Promise<string>;
}
