import type { GeneralAnswerService } from "../../ports/GeneralAnswerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface AnswerQuestionInput {
  question: string;
  conversationContext: string[];
  conversationId: QualifiedId;
  replyToMessageId: string;
}

export class AnswerQuestion {
  constructor(
    private readonly generalAnswer: GeneralAnswerService,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: AnswerQuestionInput): Promise<void> {
    const answer = await this.generalAnswer.answer(input.question, input.conversationContext);
    await this.wireOutbound.sendPlainText(input.conversationId, answer, {
      replyToMessageId: input.replyToMessageId,
    });
  }
}
