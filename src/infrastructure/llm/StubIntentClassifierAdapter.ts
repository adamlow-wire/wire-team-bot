import type { IntentClassifierService, IntentResult } from "../../domain/services/IntentClassifierService";
import type { Logger } from "../../application/ports/Logger";

/**
 * Stub intent classifier used when LLM is disabled. Always returns "none",
 * causing all messages to fall through to passive implicit detection (also stubbed).
 */
export class StubIntentClassifierAdapter implements IntentClassifierService {
  constructor(private readonly logger: Logger) {}

  async classify(text: string): Promise<IntentResult> {
    this.logger.debug("Intent classifier skipped — LLM disabled (stub)", { text: text.slice(0, 80) });
    return { intent: "none", payload: {}, confidence: 1.0 };
  }
}
