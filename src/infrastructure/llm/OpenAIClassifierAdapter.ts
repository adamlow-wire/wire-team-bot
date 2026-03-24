/**
 * Tier 1 Classifier — uses the `classify` model slot.
 * Returns categories[], is_high_signal, and entity hints for Tier 2.
 * Does NOT return a single intent; that is the old ConversationIntelligence approach.
 */

import type { ClassifierPort, ClassifyResult, ChannelContext, MessageCategory } from "../../application/ports/ClassifierPort";
import type { LLMClientFactory } from "./LLMClientFactory";
import type { Logger } from "../../application/ports/Logger";

const SYSTEM_PROMPT = `You are the Tier 1 classifier for Jeeves, a discreet British team assistant.

Classify the message into one or more of these categories:
- decision: a conclusion or choice has been made or recorded
- action: a commitment or task has been assigned or accepted
- question: an open question is posed to the team
- blocker: progress is blocked by an impediment
- update: a status update on ongoing work
- discussion: general team deliberation, not yet resolved
- reference: a link, resource, or reference to external material
- routine: greetings, acknowledgements, chit-chat, bot commands — no team knowledge

Named entities: extract any proper nouns that are project names, people, services, tools, or teams.

High signal: set is_high_signal=true when categories includes 'decision', 'action', or 'blocker'.
Low signal (discussion-only, question, update, routine): is_high_signal=false.

Return ONLY valid JSON — no markdown, no explanation:
{"categories":["<cat1>","<cat2>"],"confidence":<0.0-1.0>,"entities":["<name1>"],"is_high_signal":<true|false>}`;

const VALID_CATEGORIES: MessageCategory[] = [
  "decision", "action", "question", "blocker",
  "update", "discussion", "reference", "routine",
];

const FALLBACK: ClassifyResult = {
  categories: ["discussion"],
  confidence: 0,
  entities: [],
  is_high_signal: false,
};

export class OpenAIClassifierAdapter implements ClassifierPort {
  constructor(
    private readonly llm: LLMClientFactory,
    private readonly logger: Logger,
  ) {}

  async classify(text: string, context: ChannelContext, window: string[]): Promise<ClassifyResult> {
    const purposeLine = context.purpose ? `Channel purpose: ${context.purpose}\n` : "";
    const contextTypeLine = context.contextType ? `Channel type: ${context.contextType}\n` : "";
    const windowSample = window.slice(-5).join("\n") || "(none)";

    const userContent = [
      purposeLine + contextTypeLine,
      "Recent conversation context:",
      windowSample,
      "",
      `Message to classify: "${text}"`,
    ].join("\n");

    let result: ChatResult;
    try {
      result = await this.llm.chatCompletion("classify", [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ], { max_tokens: 150, temperature: 0 });
    } catch (err) {
      this.logger.warn("Classifier LLM call failed", { err: String(err) });
      return FALLBACK;
    }

    let parsed: {
      categories?: unknown;
      confidence?: unknown;
      entities?: unknown;
      is_high_signal?: unknown;
    };

    try {
      parsed = JSON.parse(result.content.replace(/^```json\s*|\s*```$/g, "").trim()) as typeof parsed;
    } catch {
      this.logger.warn("Classifier — failed to parse LLM response", { preview: result.content.slice(0, 200) });
      return FALLBACK;
    }

    const rawCategories = Array.isArray(parsed.categories) ? parsed.categories : [];
    const categories = rawCategories.filter(
      (c): c is MessageCategory => typeof c === "string" && VALID_CATEGORIES.includes(c as MessageCategory),
    );
    if (categories.length === 0) categories.push("discussion");

    const entities = Array.isArray(parsed.entities)
      ? parsed.entities.filter((e): e is string => typeof e === "string")
      : [];

    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5)));
    const is_high_signal =
      typeof parsed.is_high_signal === "boolean"
        ? parsed.is_high_signal
        : categories.some((c) => c === "decision" || c === "action" || c === "blocker");

    const classify: ClassifyResult = { categories, confidence, entities, is_high_signal };

    this.logger.debug("Classifier result", {
      channelId: context.channelId,
      categories,
      is_high_signal,
      confidence,
      usedFallback: result.usedFallback,
    });

    return classify;
  }
}

type ChatResult = Awaited<ReturnType<LLMClientFactory["chatCompletion"]>>;
