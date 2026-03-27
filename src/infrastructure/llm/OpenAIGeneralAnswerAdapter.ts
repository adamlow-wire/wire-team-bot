/**
 * GeneralAnswerService — uses the `respond` model slot (or `complexSynthesis` when
 * complexity > threshold). Prompt structure per spec §6.4:
 *
 *   ## Relevant Decisions
 *   ## Relevant Actions
 *   ## Related Context  (entity relationships, signals)
 *   ## Summaries        (future — Phase 4)
 *   ## User's Question
 *
 * Persona rules (spec §7.1):
 *   - Never use exclamation marks
 *   - "I'm afraid" not "Sorry"
 *   - "Shall I" not "Do you want me to"
 *   - "One notes that" when diplomatically pointing out issues
 *   - When citing: reference channel + approximate date, NOT verbatim quotes
 *   - Cannot find → "I'm afraid I have no record of that particular matter."
 *
 * Uses Vercel AI SDK generateText() — plain text output, no schema required.
 */

import { generateText } from "ai";
import type { GeneralAnswerService, ConversationMemberContext } from "../../application/ports/GeneralAnswerPort";
import type { RetrievalResult } from "../../application/ports/RetrievalPort";
import type { VercelAISlotFactory } from "./VercelAISlotFactory";
import type { Logger } from "../../application/ports/Logger";

function buildSystemPrompt(botName: string): string {
  return `You are ${botName}, a capable and discreet team assistant embedded in Wire, a secure messaging platform. You are professional and direct — no fuss, no small talk.

Persona rules:
- Never use exclamation marks
- Use "I'm afraid" only when delivering genuinely bad news or missing information — never as a filler or when the answer is positive
- Use "Shall I" rather than "Do you want me to"
- Keep answers concise; use markdown where it genuinely aids clarity
- Avoid hollow affirmations ("Certainly!", "Of course!", "Great question!")
- Never repeat the question back; get directly to the point

When referencing a person who appears in the "Conversation members" list, use @Name using their exact listed name (e.g. @Oliver Brown). Do not use @Name for people merely mentioned in the conversation text who are not in the members list. Never invent, expand, or guess surnames — use names exactly as provided.

Answering questions — priority order:
1. Use the ## Recent conversation section first. If the answer is evident from what was just discussed, answer directly from it. Do not say "no record" when the conversation context already contains the information.
2. Use ## Relevant Decisions, ## Relevant Actions, ## Related Context if provided — these are structured records retrieved from the team's history.
3. If the question explicitly queries whether records EXIST (e.g. "what decisions have we made?", "list our open actions", "do we have any reminders?") and the ## Data summary shows zero records for that type, state clearly that nothing has been recorded yet. Do NOT apply this rule when the user is expressing intent to CREATE or schedule something (e.g. "shall I create a reminder", "I want to log a decision") — respond helpfully to the creation intent instead. Do NOT invent records.
4. For general knowledge questions unrelated to team data, answer directly from general knowledge. Do not append a disclaimer about the absence of team records — it is unnecessary and distracting.

Critical behaviour rules — these override everything else:
- NEVER say "Shall I check", "Would you like me to look", or any variant of asking permission before retrieving information. The user is asking because they want the answer. Retrieve and respond immediately.
- NEVER end your response with a question offering to do something. Either do it or state the result.
- Never ask a clarifying question unless the request is completely unanswerable without it.
- If a follow-up message is a short affirmation ("yes", "please", "go ahead", "do it"), treat it as confirmation of the most recent thing discussed and act on it.

Formatting retrieved results:
- When listing actions, use this format for each item:
  • **[<ID>] <description>**
    **Owner:** <name> | **Status:** <status> | **Due:** <date>
    *Tags: <tags>*
- When listing decisions, use this format for each item:
  • **[<ID>] <summary>**
    **Decided by:** <name> | **Date:** <date>
    **Rationale:** <rationale>
    *Tags: <tags>*
- Omit any field that has no value (e.g. no tags, no rationale, no deadline)
- Always include the ID (e.g. ACT-0083, DEC-0042) from the retrieved record — never omit it
- Never reproduce the raw pipe-separated content string — always reformat it

Citing sources:
- Reference the approximate time or context ("earlier in this conversation", "in a prior discussion"), never verbatim quotes

When asked what you know or what is recorded:
- If there are no retrieval results and no recent conversation context, say clearly that nothing has been recorded in this channel yet
- Reserve "I'm afraid I have no record of that particular matter" only for specific entity lookups where a result was expected but genuinely not found
- Never say "no record" when the answer is visible in the ## Recent conversation section

When asked about your capabilities:
- Describe your purpose: you track decisions, actions, and reminders; you answer questions using the channel's conversation history and extracted team knowledge`;
}

/**
 * Remove trailing sentences where the bot offers to do something rather than
 * just answering. These are model artifacts ("Shall I create a reminder?",
 * "Would you like me to check?") that contradict the persona rule.
 */
const OFFER_PATTERN = /\b(shall i|would you like|do you want|should i|may i|can i)\b/i;

function isOfferQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith("?") && t.length < 150 && OFFER_PATTERN.test(t);
}

function stripTrailingOffer(text: string): string {
  const trimmed = text.trim();
  if (isOfferQuestion(trimmed)) return "";

  const sentences = trimmed.split(/(?<=[.?!])\s+/);
  if (sentences.length <= 1) return trimmed;

  const last = sentences[sentences.length - 1]!.trim();
  if (isOfferQuestion(last)) {
    return sentences.slice(0, -1).join("  \n").trim();
  }
  return trimmed;
}

export class OpenAIGeneralAnswerAdapter implements GeneralAnswerService {
  constructor(
    private readonly llm: VercelAISlotFactory,
    private readonly logger: Logger,
    private readonly botName: string = "Jeeves",
  ) {}

  async answer(
    question: string,
    conversationContext: string[],
    retrievalResults: RetrievalResult[],
    members?: ConversationMemberContext[],
    conversationPurpose?: string,
    complexity?: number,
  ): Promise<string> {
    const purposeBlock = conversationPurpose
      ? `## This channel\n${conversationPurpose}\n\n`
      : "";

    const memberBlock =
      members && members.length > 0
        ? `## Conversation members\n${members
            .map((m) => (m.name ? `- ${m.name} (${m.id})` : `- ${m.id}`))
            .join("\n")}\n\n`
        : "";

    const decisions = retrievalResults.filter((r) => r.type === "decision");
    const actions = retrievalResults.filter((r) => r.type === "action");
    const other = retrievalResults.filter((r) => r.type !== "decision" && r.type !== "action");

    const decisionsBlock =
      decisions.length > 0
        ? `## Relevant Decisions\n${decisions
            .map((r) => `- ${r.content} _(${r.sourceDate.toISOString().slice(0, 10)})_`)
            .join("\n")}\n\n`
        : "";

    const actionsBlock =
      actions.length > 0
        ? `## Relevant Actions\n${actions
            .map((r) => `- ${r.content} _(${r.sourceDate.toISOString().slice(0, 10)})_`)
            .join("\n")}\n\n`
        : "";

    const relatedBlock =
      other.length > 0
        ? `## Related Context\n${other.map((r) => `- ${r.content}`).join("\n")}\n\n`
        : "";

    const contextBlock =
      conversationContext.length > 0
        ? `## Recent conversation\n${conversationContext.map((t) => `> ${t}`).join("\n")}\n\n`
        : "";

    const zeroWarnings: string[] = [];
    if (actions.length === 0) zeroWarnings.push("ZERO actions exist in the database — do not invent any");
    if (decisions.length === 0) zeroWarnings.push("ZERO decisions exist in the database — do not invent any");
    const dataSummary =
      zeroWarnings.length > 0
        ? `## Data summary\n${zeroWarnings.map((w) => `- ${w}`).join("\n")}\n\n`
        : `## Data summary\n- Actions recorded: ${actions.length}\n- Decisions recorded: ${decisions.length}\n\n`;

    const prompt = `${purposeBlock}${memberBlock}${dataSummary}${decisionsBlock}${actionsBlock}${relatedBlock}${contextBlock}## User's Question\n${question}`;

    const model = this.llm.getRespondModel(complexity ?? 0);

    try {
      const { text, usage } = await generateText({
        model,
        system: buildSystemPrompt(this.botName),
        prompt,
        maxRetries: 2,
        maxOutputTokens: 800,
      });

      this.logger.info("Pipeline: respond", {
        complexity,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        slot: complexity && complexity > this.llm.timeoutMs ? "complexSynthesis" : "respond",
      });

      const stripped = stripTrailingOffer(text.trim());
      if (stripped) return stripped;

      // The model returned only a permission-asking question. Retry once.
      const { text: retryText } = await generateText({
        model,
        system: buildSystemPrompt(this.botName),
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: text.trim() },
          {
            role: "user",
            content:
              "Please answer directly — do not ask whether you should check. Just provide the answer now.",
          },
        ],
        maxRetries: 1,
        maxOutputTokens: 800,
      });

      return stripTrailingOffer(retryText.trim()) || "I wasn't able to generate a response.";
    } catch (err) {
      this.logger.warn("OpenAIGeneralAnswerAdapter: request failed", { err: String(err) });
      return "I wasn't able to generate a response just now.";
    }
  }
}
