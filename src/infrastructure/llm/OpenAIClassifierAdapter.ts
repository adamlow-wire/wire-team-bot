/**
 * Tier 1 Classifier — uses the `classify` model slot.
 * Returns categories[], is_high_signal, and entity hints for Tier 2.
 * Uses Vercel AI SDK generateObject() with Zod schema — no manual JSON parsing.
 */

import { generateObject } from "ai";
import type { ClassifierPort, ClassifyResult, ChannelContext } from "../../application/ports/ClassifierPort";
import type { VercelAISlotFactory } from "./VercelAISlotFactory";
import type { Logger } from "../../application/ports/Logger";
import { ClassifyOutputSchema } from "../../domain/schemas/classifier";

function buildSystemPrompt(botName: string): string {
  return `You are the Tier 1 classifier for ${botName}, a discreet team assistant.

Classify the message into one or more of these categories:
- decision: a conclusion or choice has been made or recorded
- action: a commitment or task has been assigned or accepted
- question: an open question is posed to the team
- blocker: progress is blocked by an impediment
- update: a status update on ongoing work
- discussion: general team deliberation, not yet resolved
- reference: a link, document, or resource shared
- routine: small talk, acknowledgements, non-substantive chat

Named entities: extract any proper nouns that are project names, people, services, tools, or teams.

High signal: set is_high_signal=true when categories includes 'decision', 'action', or 'blocker'.
Low signal (discussion-only, question, update, reference, routine): is_high_signal=false.`;
}

const FALLBACK: ClassifyResult = {
  categories: ["discussion"],
  confidence: 0,
  entities: [],
  is_high_signal: false,
};

export class OpenAIClassifierAdapter implements ClassifierPort {
  constructor(
    private readonly llm: VercelAISlotFactory,
    private readonly logger: Logger,
    private readonly botName: string = "Jeeves",
  ) {}

  async classify(text: string, context: ChannelContext, window: string[]): Promise<ClassifyResult> {
    const purposeLine = context.purpose ? `Channel purpose: ${context.purpose}\n` : "";
    const contextTypeLine = context.contextType ? `Channel type: ${context.contextType}\n` : "";
    const windowSample = window.slice(-5).join("\n") || "(none)";

    const prompt = [
      purposeLine + contextTypeLine,
      "Recent conversation context:",
      windowSample,
      "",
      `Message to classify: "${text}"`,
    ].join("\n");

    try {
      const { object, usage } = await generateObject({
        model: this.llm.getModel("classify"),
        schema: ClassifyOutputSchema,
        system: buildSystemPrompt(this.botName),
        prompt,
        maxRetries: 2,
      });

      this.logger.info("Pipeline: Tier 1 classify", {
        channelId: context.channelId,
        categories: object.categories,
        is_high_signal: object.is_high_signal,
        confidence: object.confidence,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        slot: "classify",
      });

      return {
        categories: object.categories.length > 0 ? object.categories : ["discussion"],
        confidence: object.confidence,
        entities: object.entities,
        is_high_signal: object.is_high_signal,
      };
    } catch (err) {
      this.logger.warn("Classifier LLM call failed", { err: String(err) });
      return FALLBACK;
    }
  }
}
