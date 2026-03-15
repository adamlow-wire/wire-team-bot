import type {
  ConversationIntelligenceService,
  ConversationIntelligenceInput,
  ConversationIntelligenceResult,
} from "../../domain/services/ConversationIntelligenceService";
import type { Logger } from "../../application/ports/Logger";

export class StubConversationIntelligenceAdapter implements ConversationIntelligenceService {
  constructor(private readonly logger: Logger) {}

  async analyze(_input: ConversationIntelligenceInput): Promise<ConversationIntelligenceResult> {
    this.logger.debug("Conversation intelligence skipped — LLM disabled (stub)");
    return { intent: "none", payload: {}, confidence: 1.0, shouldRespond: false };
  }
}
