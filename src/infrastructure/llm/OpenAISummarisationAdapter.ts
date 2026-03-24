/**
 * Summarisation adapter — uses the `summarise` model slot.
 * Synthesises signals, decisions, and actions for a period into a rolling
 * channel summary. Source text is never included verbatim in the output.
 * Falls back to a minimal stub summary on LLM error or malformed JSON.
 */

import type { SummarisationPort, SignalInput, SummaryResult } from "../../application/ports/SummarisationPort";
import type { Decision } from "../../domain/entities/Decision";
import type { Action } from "../../domain/entities/Action";
import type { SummaryGranularity, SummarySentiment } from "../../domain/entities/ConversationSummary";
import type { LLMClientFactory } from "./LLMClientFactory";
import type { Logger } from "../../application/ports/Logger";

const SYSTEM_PROMPT = `You are the summarisation engine for Jeeves, a discreet British team assistant.

Your task is to produce a rolling channel summary from structured data — decisions, actions, and signals.
Never reproduce verbatim quotes. Synthesise. Be concise and objective.

Sentiment values: productive | contentious | blocked | routine

Return ONLY valid JSON:
{
  "summary": "<2-4 sentence paragraph>",
  "keyDecisions": ["<decision-id-1>"],
  "keyActions": ["<action-id-1>"],
  "activeTopics": ["<topic1>", "<topic2>"],
  "participants": ["<name1>"],
  "sentiment": "<sentiment>",
  "messageCount": <integer>
}`;

const VALID_SENTIMENTS = new Set<string>(["productive", "contentious", "blocked", "routine"]);

export class OpenAISummarisationAdapter implements SummarisationPort {
  constructor(
    private readonly llm: LLMClientFactory,
    private readonly logger: Logger,
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
                `[${a.id}] ${a.description} — ${a.assigneeName || a.assigneeId.id} (${a.status})` +
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

    const priorBlock = priorSummary
      ? `## Previous summary\n${priorSummary}`
      : "";

    const userContent = [
      `Channel: ${channelId}`,
      `Granularity: ${granularity}`,
      priorBlock,
      decisionsBlock,
      actionsBlock,
      signalsBlock,
    ]
      .filter(Boolean)
      .join("\n\n");

    let raw: string;
    try {
      const result = await this.llm.chatCompletion(
        "summarise",
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        { max_tokens: 600, temperature: 0.3 },
      );
      raw = result.content;
    } catch (err) {
      this.logger.warn("OpenAISummarisationAdapter: LLM call failed", { err: String(err) });
      return fallback(decisions, actions, signals);
    }

    try {
      const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      const parsed = JSON.parse(json) as Record<string, unknown>;
      return parseSummaryResult(parsed, decisions, actions, signals);
    } catch {
      this.logger.warn("OpenAISummarisationAdapter: malformed JSON, using fallback", {
        raw: raw.slice(0, 200),
      });
      return fallback(decisions, actions, signals);
    }
  }
}

function parseSummaryResult(
  raw: Record<string, unknown>,
  decisions: Decision[],
  actions: Action[],
  signals: SignalInput[],
): SummaryResult {
  const summary =
    typeof raw.summary === "string" && raw.summary.trim().length > 0
      ? raw.summary.trim()
      : fallback(decisions, actions, signals).summary;

  const keyDecisions = Array.isArray(raw.keyDecisions)
    ? (raw.keyDecisions as unknown[]).filter((id): id is string => typeof id === "string")
    : decisions.slice(0, 3).map((d) => d.id);

  const keyActions = Array.isArray(raw.keyActions)
    ? (raw.keyActions as unknown[]).filter((id): id is string => typeof id === "string")
    : actions.slice(0, 3).map((a) => a.id);

  const activeTopics = Array.isArray(raw.activeTopics)
    ? (raw.activeTopics as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

  const participants = Array.isArray(raw.participants)
    ? (raw.participants as unknown[]).filter((p): p is string => typeof p === "string")
    : [];

  const sentiment: SummarySentiment = VALID_SENTIMENTS.has(raw.sentiment as string)
    ? (raw.sentiment as SummarySentiment)
    : "routine";

  const messageCount =
    typeof raw.messageCount === "number" ? raw.messageCount : signals.length;

  return { summary, keyDecisions, keyActions, activeTopics, participants, sentiment, messageCount };
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
