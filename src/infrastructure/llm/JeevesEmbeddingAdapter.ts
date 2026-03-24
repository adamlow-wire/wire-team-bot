/**
 * Embedding adapter for the Phase 2 pipeline.
 * Uses the `embed` model slot from JeevesLLMConfig (JEEVES_MODEL_EMBED / JEEVES_FALLBACK_EMBED).
 * Calls the OpenAI-compatible /embeddings endpoint.
 *
 * Implements the EmbeddingService port.
 */

import type { EmbeddingService } from "../../application/ports/EmbeddingPort";
import type { JeevesLLMConfig } from "../../app/config";
import type { Logger } from "../../application/ports/Logger";

export class JeevesEmbeddingAdapter implements EmbeddingService {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly model: string;
  private readonly fallbackModel: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: JeevesLLMConfig,
    private readonly logger: Logger,
  ) {
    this.url = `${config.baseUrl.replace(/\/$/, "")}/embeddings`;
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };
    this.model = config.slots.embed.model;
    this.fallbackModel = config.slots.embed.fallback;
    this.timeoutMs = config.timeoutMs;
  }

  async embed(text: string): Promise<number[] | null> {
    try {
      const vec = await this.attempt(this.model, [text]);
      return vec[0] ?? null;
    } catch (primaryErr) {
      if (!isFallbackable(primaryErr)) {
        this.logger.warn("Embedding call failed (non-retryable)", { err: String(primaryErr) });
        return null;
      }
      this.logger.warn("Embedding primary model failed, retrying with fallback", {
        primaryModel: this.model,
        fallbackModel: this.fallbackModel,
        err: String(primaryErr),
      });
      try {
        const vec = await this.attempt(this.fallbackModel, [text]);
        return vec[0] ?? null;
      } catch (fallbackErr) {
        this.logger.warn("Embedding fallback model also failed", { err: String(fallbackErr) });
        return null;
      }
    }
  }

  async embedBatch(texts: string[]): Promise<Array<number[] | null>> {
    if (texts.length === 0) return [];
    try {
      const vectors = await this.attempt(this.model, texts);
      return texts.map((_, i) => vectors[i] ?? null);
    } catch (primaryErr) {
      if (!isFallbackable(primaryErr)) {
        this.logger.warn("Batch embedding failed (non-retryable)", { err: String(primaryErr) });
        return texts.map(() => null);
      }
      try {
        const vectors = await this.attempt(this.fallbackModel, texts);
        return texts.map((_, i) => vectors[i] ?? null);
      } catch {
        return texts.map(() => null);
      }
    }
  }

  private async attempt(model: string, inputs: string[]): Promise<Array<number[]>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ model, input: inputs }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 503) throw new ServiceUnavailableError(model);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Embedding request failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const sorted = (data.data ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((d) => d.embedding ?? []);
  }
}

class ServiceUnavailableError extends Error {
  constructor(public readonly model: string) {
    super(`Embedding service unavailable for model ${model}`);
  }
}

function isFallbackable(err: unknown): boolean {
  return err instanceof ServiceUnavailableError || (err instanceof Error && err.name === "AbortError");
}
