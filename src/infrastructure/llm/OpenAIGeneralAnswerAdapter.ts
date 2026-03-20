import type { GeneralAnswerService, KnowledgeContext, ConversationMemberContext } from "../../application/ports/GeneralAnswerPort";
import type { LLMConfig } from "./LLMConfigAdapter";
import type { Logger } from "../../application/ports/Logger";

const BASE_SYSTEM_PROMPT = `You are Jeeves, a discreet and highly capable team assistant embedded in Wire, a secure messaging platform. You speak with the measured, understated confidence of a skilled British butler — helpful, precise, and never flustered. Use concise, clear English. Avoid hollow affirmations ("Certainly!", "Of course!", "Great question!"). Never repeat the question back. Get directly to the point.

You assist the team with:
- Tasks, actions, decisions, and reminders — detected automatically from conversation or recorded explicitly
- Answering questions using the team's stored knowledge base, citing entry IDs (e.g. KB-0001) inline
- Secret mode: when activated, you stop listening entirely and nothing is sent to any AI service

When knowledge base entries are provided below, treat them as your primary source of truth. Cite the entry ID inline when drawing on a specific entry. If the entries do not fully cover the question, say so and supplement with general knowledge where appropriate. If no entries are provided, answer from general knowledge and acknowledge you have no specific team knowledge on the topic.

Use markdown where it genuinely aids clarity. Keep answers appropriately brief.`;

export class OpenAIGeneralAnswerAdapter implements GeneralAnswerService {
  constructor(private readonly config: LLMConfig, private readonly logger: Logger) {}

  async answer(
    question: string,
    conversationContext: string[],
    knowledgeContext: KnowledgeContext[],
    members?: ConversationMemberContext[],
    conversationPurpose?: string,
  ): Promise<string> {
    if (!this.config.enabled) {
      return "I'm afraid I'm unable to answer general questions at present — no capable model is configured.";
    }

    const url = `${this.config.baseUrl}/chat/completions`;

    const purposeBlock = conversationPurpose
      ? `## This channel\n${conversationPurpose}\n\n`
      : "";

    const memberBlock =
      members && members.length > 0
        ? `## Conversation members\n${members.map((m) => m.name ? `- ${m.name} (${m.id})` : `- ${m.id}`).join("\n")}\n\n`
        : "";

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
        { role: "system", content: BASE_SYSTEM_PROMPT },
        { role: "user", content: `${purposeBlock}${memberBlock}${kbBlock}${contextBlock}${question}` },
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
        return "I'm afraid I wasn't able to respond in time — the request timed out.";
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      this.logger.warn("General answer LLM request failed", { status: res.status, err: errText });
      return "I wasn't able to generate a response just now.";
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? "I wasn't able to generate a response.";
  }
}
