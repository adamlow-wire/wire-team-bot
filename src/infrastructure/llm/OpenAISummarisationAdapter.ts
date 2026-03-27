/**
 * Summarisation adapter — uses the `summarise` model slot.
 * Synthesises signals, decisions, and actions for a period into a rolling
 * channel summary. Source text is never included verbatim in the output.
 * Falls back to a minimal stub summary on LLM error.
 * Uses Vercel AI SDK generateObject() with Zod schema — no manual JSON parsing.
 */

import { generateObject } from "ai";
import type { SummarisationPort, SignalInput, SummaryResult } from "../../application/ports/SummarisationPort";
import type { Decision } from "../../domain/entities/Decision";
import type { Action } from "../../domain/entities/Action";
import type { SummaryGranularity } from "../../domain/entities/ConversationSummary";
import type { VercelAISlotFactory } from "./VercelAISlotFactory";
import type { Logger } from "../../application/ports/Logger";
import { SummaryOutputSchema } from "../../domain/schemas/summarisation";

function buildSystemPrompt(botName: string): string {
  return `You are the summarisation engine for ${botName}, a discreet team assistant.

Your task is to produce a rolling channel summary from structured data — decisions, actions, and signals.
Never reproduce verbatim quotes. Synthesise. Be concise and objective.

Sentiment values: productive | contentious | blocked | routine`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function resolveOwner(a: Action): string {
  const name = a.assigneeName;
  return name && !UUID_RE.test(name) ? name : "unassigned";
}

export class OpenAISummarisationAdapter implements SummarisationPort {
  constructor(
    private readonly llm: VercelAISlotFactory,
    private readonly logger: Logger,
    private readonly botName: string = "Jeeves",
  ) {}

  async summarise(
    channelId: string,
    signals: SignalInput[],
    decisions: Decision[],
    actions: Action[],
    priorSummary: string | null,
    granularity: SummaryGranularity,
  ): Promise<SummaryResult> {
    const decisionsBlock =
      decisions.length > 0
        ? `## Decisions\n${decisions
            .map(
              (d) =>
                `[${d.id}] ${d.summary}` +
                (d.decidedBy?.length ? ` — by ${d.decidedBy.join(", ")}` : "") +
                (d.decidedAt ? ` on ${d.decidedAt.toISOString().slice(0, 10)}` : ""),
            )
            .join("\n")}`
        : "";

    const actionsBlock =
      actions.length > 0
        ? `## Actions\n${actions
            .map(
              (a) =>
                `[${a.id}] ${a.description} — ${resolveOwner(a)} (${a.status})` +
                (a.deadline ? ` due ${a.deadline.toISOString().slice(0, 10)}` : ""),
            )
            .join("\n")}`
        : "";

    const signalsBlock =
      signals.length > 0
        ? `## Signals\n${signals
            .map((s) => `[${s.occurredAt.toISOString().slice(0, 16)}] ${s.signalType}: ${s.summary}`)
            .join("\n")}`
        : "";

    const priorBlock = priorSummary ? `## Previous summary\n${priorSummary}` : "";

    const prompt = [
      `Channel: ${channelId}`,
      `Granularity: ${granularity}`,
      priorBlock,
      decisionsBlock,
      actionsBlock,
      signalsBlock,
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const { object, usage } = await generateObject({
        model: this.llm.getModel("summarise"),
        schema: SummaryOutputSchema,
        system: buildSystemPrompt(this.botName),
        prompt,
        maxRetries: 2,
      });

      this.logger.info("Pipeline: summarise", {
        channelId,
        granularity,
        sentiment: object.sentiment,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        slot: "summarise",
      });

      return {
        summary: object.summary,
        keyDecisions: object.keyDecisions,
        keyActions: object.keyActions,
        activeTopics: object.activeTopics,
        participants: object.participants,
        sentiment: object.sentiment,
        messageCount: object.messageCount || signals.length,
      };
    } catch (err) {
      this.logger.warn("OpenAISummarisationAdapter: LLM call failed", { err: String(err) });
      return fallback(decisions, actions, signals);
    }
  }
}

function fallback(decisions: Decision[], actions: Action[], signals: SignalInput[]): SummaryResult {
  const parts: string[] = [];
  if (decisions.length > 0) parts.push(`${decisions.length} decision(s) recorded`);
  if (actions.length > 0) parts.push(`${actions.length} action(s) tracked`);
  if (signals.length > 0) parts.push(`${signals.length} conversation signal(s) captured`);
  return {
    summary: parts.length > 0 ? parts.join(", ") + "." : "No significant activity in this period.",
    keyDecisions: decisions.slice(0, 3).map((d) => d.id),
    keyActions: actions.slice(0, 3).map((a) => a.id),
    activeTopics: [],
    participants: [],
    sentiment: "routine",
    messageCount: signals.length,
  };
}
