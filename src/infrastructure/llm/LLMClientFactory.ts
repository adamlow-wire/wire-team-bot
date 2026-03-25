/**
 * LLMClientFactory
 *
 * Provides a unified fetch-based OpenAI-compatible client for all seven model
 * slots. Handles per-slot model selection and a single fallback retry:
 *   - On 503 or AbortError (timeout): retry once with the slot's fallback model.
 *   - Both attempts are logged.
 *
 * Usage:
 *   const factory = new LLMClientFactory(config.llm.jeeves, logger);
 *   const result = await factory.chatCompletion("classify", messages, { max_tokens: 200 });
 */

import type { JeevesLLMConfig, JeevesModelSlot } from "../../app/config";
import type { Logger } from "../../application/ports/Logger";

export type SlotName = keyof JeevesLLMConfig["slots"];

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

  constructor(
    private readonly config: JeevesLLMConfig,
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

    const slotCfg: JeevesModelSlot = this.config.slots[effectiveSlot];

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
        err: String(err),
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

    // Strip internal-only fields before sending to the API
    const { complexity: _c, escalateToSlot: _e, ...apiOptions } = options;

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ model, messages, ...apiOptions }),
        signal: controller.signal,
      });
    } catch (err) {
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 503) {
      throw new LLMServiceUnavailableError(model, res.status);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM request failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    // Strip <think>…</think> blocks emitted by reasoning models (e.g. qwen3-think variants)
    return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
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
