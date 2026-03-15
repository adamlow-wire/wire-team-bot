import type { ImplicitDetectionService, ImplicitDetectionInput, ImplicitCandidate } from "../../domain/services/ImplicitDetectionService";
import type { LLMConfig } from "./LLMConfigAdapter";
import type { Logger } from "../../application/ports/Logger";

/**
 * Stub implementation of ImplicitDetectionService. Returns no candidates.
 * Used when LLM is disabled or not configured. Replace with a real LLM-backed
 * adapter (e.g. OpenAIImplicitDetectionAdapter) in Phase 3.
 */
export class StubImplicitDetectionAdapter implements ImplicitDetectionService {
  constructor(private readonly _config: LLMConfig, private readonly logger: Logger) {}

  async detect(input: ImplicitDetectionInput): Promise<ImplicitCandidate[]> {
    this.logger.debug("Implicit detection skipped — LLM disabled (stub)", { conversationId: input.conversationId.id });
    return [];
  }
}
