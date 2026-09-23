/**
 * LLMClientFactory
 *
 * Provides a unified fetch-based OpenAI-compatible client for all seven model
 * slots. Handles per-slot model selection and a single fallback retry:
 *   - On 503/529 or AbortError (timeout): retry once with the slot's fallback model.
 *   - Both attempts are logged.
 *
 * A model that rejects `temperature` as deprecated or unsupported is remembered for
 * the life of the instance, and later requests to it omit the parameter. Share one
 * instance across adapters so each model is learned once per process.
 *
 * Usage:
 *   const factory = new LLMClientFactory(config.llm.bot, logger);
 *   const result = await factory.chatCompletion("classify", messages, { max_tokens: 200 });
 */

import type { LLMConfig, ModelSlot } from "../../app/config";
import type { Logger } from "../../application/ports/Logger";

export type SlotName = keyof LLMConfig["slots"];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: "json_object" } | { type: "text" };
  /**
   * When set and above config.complexityThreshold, the request is escalated to
   * the slot named by `escalateToSlot` (default: "complexSynthesis").
   */
  complexity?: number;
  /** Slot to escalate to when complexity > threshold. Defaults to "complexSynthesis". */
  escalateToSlot?: SlotName;
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  usedFallback: boolean;
}

export class LLMClientFactory {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  /** Models whose provider has rejected `temperature`; requests to them omit it. */
  private readonly modelsRejectingTemperature = new Set<string>();

  constructor(
    private readonly config: LLMConfig,
    private readonly logger: Logger,
  ) {
    this.url = `${config.baseUrl}/chat/completions`;
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };
  }

  async chatCompletion(
    slot: SlotName,
    messages: ChatMessage[],
    options: ChatCompletionOptions = {},
  ): Promise<ChatCompletionResult> {
    // Complexity escalation: when query complexity exceeds threshold, use a more
    // capable model slot (default: complexSynthesis) for the generation call.
    const effectiveSlot: SlotName =
      options.complexity !== undefined &&
      options.complexity > this.config.complexityThreshold &&
      (options.escalateToSlot ?? "complexSynthesis" as SlotName) in this.config.slots
        ? (options.escalateToSlot ?? "complexSynthesis" as SlotName)
        : slot;

    const slotCfg: ModelSlot = this.config.slots[effectiveSlot];

    // Primary attempt
    try {
      const content = await this.attempt(slotCfg.model, messages, options);
      return { content, model: slotCfg.model, usedFallback: false };
    } catch (err) {
      const isFallbackable = this.isFallbackError(err);
      if (!isFallbackable) throw err;
      this.logger.warn("LLM primary attempt failed, retrying with fallback", {
        slot: effectiveSlot,
        primaryModel: slotCfg.model,
        fallbackModel: slotCfg.fallback,
        err: (err instanceof Error ? err.name : "UnknownError"),
      });
    }

    // Fallback attempt
    const content = await this.attempt(slotCfg.fallback, messages, options);
    return { content, model: slotCfg.fallback, usedFallback: true };
  }

  private async attempt(
    model: string,
    messages: ChatMessage[],
    options: ChatCompletionOptions,
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    // Strip internal-only fields before sending to the API, and temperature for a
    // model already known to reject it.
    const { complexity: _c, escalateToSlot: _e, ...requestOptions } = options;
    const { temperature: _t, ...withoutTemperature } = requestOptions;
    const apiOptions: Omit<ChatCompletionOptions, "complexity" | "escalateToSlot"> =
      this.modelsRejectingTemperature.has(model) ? withoutTemperature : requestOptions;

    try {
      const res = await fetch(this.url, {
        method: "POST", headers: this.headers,
        body: JSON.stringify({ model, messages, ...apiOptions }), signal: controller.signal,
      });
      if (res.status === 503 || res.status === 529) throw new LLMServiceUnavailableError(model, res.status);
      if (!res.ok) {
        // Some models explicitly reject temperature. Remember the model and retry this
        // read-only request once without it; never log the provider body (it may echo input).
        // The retry cannot loop: the model is now remembered, so it sends no temperature.
        if (res.status === 400 && apiOptions.temperature !== undefined) {
          const body = await res.json().catch(() => null) as { error?: { message?: unknown } } | null;
          const message = body?.error?.message;
          if (typeof message === "string" && /temperature/i.test(message) && /deprecated|unsupported|not supported/i.test(message)) {
            clearTimeout(timeout);
            this.modelsRejectingTemperature.add(model);
            this.logger.info("Model rejected temperature; omitting it for this model", { model });
            return await this.attempt(model, messages, options);
          }
        }
        throw new Error(`LLM request failed (${res.status})`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("LLM returned no text");
      return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    } finally {
      clearTimeout(timeout);
    }
  }

  private isFallbackable(err: unknown): boolean {
    return err instanceof LLMServiceUnavailableError || (err instanceof Error && err.name === "AbortError");
  }

  // alias so we can call it from the catch block where TS narrows to unknown
  private isFallbackError = this.isFallbackable.bind(this);
}

export class LLMServiceUnavailableError extends Error {
  constructor(public readonly model: string, public readonly status: number) {
    super(`LLM service unavailable for model ${model} (HTTP ${status})`);
    this.name = "LLMServiceUnavailableError";
  }
}
