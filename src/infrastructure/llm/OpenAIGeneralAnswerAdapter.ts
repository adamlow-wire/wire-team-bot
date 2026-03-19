import type { GeneralAnswerService, KnowledgeContext } from "../../application/ports/GeneralAnswerPort";
import type { LLMConfig } from "./LLMConfigAdapter";
import type { Logger } from "../../application/ports/Logger";

const SYSTEM_PROMPT = `You are a helpful team collaboration assistant embedded in Wire, a secure messaging platform. \
Answer questions concisely and helpfully. Keep answers brief and to the point. Use markdown formatting where it aids clarity.

When knowledge base entries are provided below, use them as your primary source of truth. \
Cite the entry ID (e.g. KB-0001) inline when drawing on a specific entry. \
If the knowledge base entries do not fully cover the question, say so clearly and supplement with general knowledge where appropriate. \
If no knowledge base entries are provided, answer from general knowledge and make clear you don't have specific team knowledge on this topic.`;

export class OpenAIGeneralAnswerAdapter implements GeneralAnswerService {
  constructor(private readonly config: LLMConfig, private readonly logger: Logger) {}

  async answer(question: string, conversationContext: string[], knowledgeContext: KnowledgeContext[]): Promise<string> {
    if (!this.config.enabled) {
      return "I'm not able to answer general questions right now — no capable LLM is configured.";
    }

    const url = `${this.config.baseUrl}/chat/completions`;

    const kbBlock =
      knowledgeContext.length > 0
        ? `## Knowledge Base\n${knowledgeContext
            .map(
              (k) =>
                `[${k.id}] ${k.summary} _(${k.confidence}, ${k.updatedAt.toISOString().slice(0, 10)})_\n${k.detail.slice(0, 300)}${k.detail.length > 300 ? "…" : ""}`,
            )
            .join("\n\n")}\n\n`
        : "";

    const contextBlock =
      conversationContext.length > 0
        ? `## Recent conversation\n${conversationContext.map((t) => `> ${t}`).join("\n")}\n\n`
        : "";

    const body = {
      model: this.config.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${kbBlock}${contextBlock}${question}` },
      ],
      max_tokens: 800,
      temperature: 0.7,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        this.logger.warn("General answer LLM request timed out");
        return "I wasn't able to respond in time — the request timed out.";
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      this.logger.warn("General answer LLM request failed", { status: res.status, err: errText });
      return "I wasn't able to generate a response right now.";
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? "I wasn't able to generate a response.";
  }
}
