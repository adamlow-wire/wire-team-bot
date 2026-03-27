/**
 * VercelAISlotFactory — replaces LLMClientFactory.
 *
 * Maps the seven-slot model config onto Vercel AI SDK models using the
 * OpenAI-compatible provider. All slots share one baseURL/apiKey.
 *
 * Usage:
 *   const factory = new VercelAISlotFactory(config.llm.jeeves, logger);
 *   const { object, usage } = await generateObject({
 *     model: factory.getModel("classify"),
 *     schema: ClassifyOutputSchema,
 *     prompt: "...",
 *     maxRetries: 2,
 *   });
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { JeevesLLMConfig } from "../../app/config";
import type { Logger } from "../../application/ports/Logger";

export type SlotName = keyof JeevesLLMConfig["slots"];

export class VercelAISlotFactory {
  private readonly provider: ReturnType<typeof createOpenAI>;

  constructor(
    private readonly config: JeevesLLMConfig,
    private readonly logger: Logger,
  ) {
    this.provider = createOpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || "ollama", // Ollama requires a non-empty key
    });
  }

  /**
   * Returns the primary model for a slot.
   * For complexity-driven escalation, callers should call getModel("complexSynthesis")
   * directly when complexity > config.complexityThreshold.
   */
  getModel(slot: SlotName): LanguageModel {
    const slotCfg = this.config.slots[slot];
    this.logger.debug("VercelAISlotFactory: resolving slot", { slot, model: slotCfg.model });
    return this.provider(slotCfg.model);
  }

  /**
   * Returns the fallback model for a slot (used on retry after 503/timeout).
   */
  getFallbackModel(slot: SlotName): LanguageModel {
    const slotCfg = this.config.slots[slot];
    return this.provider(slotCfg.fallback);
  }

  /**
   * Returns the respond model, escalating to complexSynthesis if complexity
   * exceeds the configured threshold.
   */
  getRespondModel(complexity: number): LanguageModel {
    const effectiveSlot: SlotName =
      complexity > this.config.complexityThreshold ? "complexSynthesis" : "respond";
    return this.getModel(effectiveSlot);
  }

  get timeoutMs(): number {
    return this.config.timeoutMs;
  }
}
