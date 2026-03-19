import type { EmbeddingService } from "../../application/ports/EmbeddingPort";
import type { EmbeddingConfig } from "./LLMConfigAdapter";
import type { Logger } from "../../application/ports/Logger";

export class OpenAIEmbeddingAdapter implements EmbeddingService {
  constructor(private readonly config: EmbeddingConfig, private readonly logger: Logger) {}

  async embed(text: string): Promise<number[] | null> {
    const results = await this.embedBatch([text]);
    return results[0] ?? null;
  }

  async embedBatch(texts: string[]): Promise<Array<number[] | null>> {
    if (!this.config.enabled || texts.length === 0) {
      return texts.map(() => null);
    }

    const url = `${this.config.baseUrl.replace(/\/$/, "")}/embeddings`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ model: this.config.model, input: texts }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        this.logger.warn("Embedding request timed out");
      } else {
        this.logger.warn("Embedding request failed", { err: String(err) });
      }
      return texts.map(() => null);
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      this.logger.warn("Embedding API error", { status: res.status, err: errText });
      return texts.map(() => null);
    }

    const data = (await res.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };

    if (!data.data) return texts.map(() => null);

    const result: Array<number[] | null> = texts.map(() => null);
    for (const item of data.data) {
      if (typeof item.index === "number" && Array.isArray(item.embedding)) {
        result[item.index] = item.embedding;
      }
    }
    return result;
  }
}
