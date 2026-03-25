import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { ConversationSummaryRepository } from "../../../domain/repositories/ConversationSummaryRepository";
import type { GenerateSummary } from "./GenerateSummary";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

/** How old a cached daily summary can be before we regenerate (25 h). */
const CACHED_SUMMARY_MAX_AGE_MS = 25 * 60 * 60 * 1000;
/** How far back an on-demand summary looks when no recent summary exists (24 h). */
const ON_DEMAND_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface CatchMeUpInput {
  conversationId: QualifiedId;
  channelId: string;
  organisationId: string;
  replyToMessageId: string;
}

/**
 * Handles "@Jeeves catch me up" / "what did I miss".
 *
 * 1. Check for a fresh daily summary (< 25 h). If found, post it.
 * 2. Otherwise, generate an on-demand summary for the last 24 h.
 */
export class CatchMeUpCommand {
  constructor(
    private readonly summaryRepo: ConversationSummaryRepository,
    private readonly generateSummary: GenerateSummary,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: CatchMeUpInput): Promise<void> {
    const { conversationId, channelId, organisationId, replyToMessageId } = input;
    const now = new Date();

    // Check for a recent daily summary
    const cached = await this.summaryRepo.findLatest(channelId, "daily").catch(() => null);
    if (cached && now.getTime() - cached.generatedAt.getTime() < CACHED_SUMMARY_MAX_AGE_MS) {
      await this.wireOutbound.sendPlainText(
        conversationId,
        formatSummary(cached.summary, cached.periodStart, cached.periodEnd, cached.sentiment),
        { replyToMessageId },
      );
      return;
    }

    // Generate on-demand
    const periodEnd = now;
    const periodStart = new Date(now.getTime() - ON_DEMAND_LOOKBACK_MS);

    const generated = await this.generateSummary
      .execute({ channelId, organisationId, granularity: "on_demand", periodStart, periodEnd })
      .catch(() => null);

    if (!generated) {
      await this.wireOutbound.sendPlainText(
        conversationId,
        "I'm afraid I have no record of significant activity in the past 24 hours.",
        { replyToMessageId },
      );
      return;
    }

    await this.wireOutbound.sendPlainText(
      conversationId,
      formatSummary(generated.summary, generated.periodStart, generated.periodEnd, generated.sentiment),
      { replyToMessageId },
    );
  }
}

function formatSummary(
  summary: string,
  periodStart: Date,
  periodEnd: Date,
  sentiment?: string,
): string {
  const from = periodStart.toISOString().slice(0, 16).replace("T", " ");
  const to = periodEnd.toISOString().slice(0, 16).replace("T", " ");
  const sentimentNote = sentiment && sentiment !== "routine" ? ` _(${sentiment})_` : "";
  return `**Catch-up: ${from} → ${to}**${sentimentNote}\n\n${summary}`;
}
