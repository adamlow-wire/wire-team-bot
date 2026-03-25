import type { SummarisationPort } from "../../ports/SummarisationPort";
import type { DecisionRepository } from "../../../domain/repositories/DecisionRepository";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { ConversationSignalRepository } from "../../../domain/repositories/ConversationSignalRepository";
import type { ConversationSummaryRepository } from "../../../domain/repositories/ConversationSummaryRepository";
import type { ConversationSummary, SummaryGranularity } from "../../../domain/entities/ConversationSummary";
import type { Logger } from "../../ports/Logger";
import { fromChannelId } from "../../../infrastructure/wire/channelId";

export interface GenerateSummaryInput {
  channelId: string;
  organisationId: string;
  granularity: SummaryGranularity;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Generates (or regenerates) a rolling summary for a channel period.
 *
 * Flow:
 * 1. Query signals, decisions, and actions for the period
 * 2. Fetch the prior summary (daily → previous daily; weekly → previous weekly)
 * 3. Call SummarisationPort
 * 4. Persist via ConversationSummaryRepository (upsert)
 */
export class GenerateSummary {
  constructor(
    private readonly summarise: SummarisationPort,
    private readonly signalRepo: ConversationSignalRepository,
    private readonly decisionRepo: DecisionRepository,
    private readonly actionRepo: ActionRepository,
    private readonly summaryRepo: ConversationSummaryRepository,
    private readonly logger: Logger,
  ) {}

  async execute(input: GenerateSummaryInput): Promise<ConversationSummary | null> {
    const { channelId, organisationId, granularity, periodStart, periodEnd } = input;

    // Gather inputs for the period
    let signals, decisions, actions;
    try {
      [signals, decisions, actions] = await Promise.all([
        this.signalRepo.query(channelId, periodStart, periodEnd),
        this.decisionRepo.query({
          conversationId: fromChannelId(channelId),
          statusIn: ["active"],
          limit: 50,
        }),
        this.actionRepo.query({
          conversationId: fromChannelId(channelId),
          statusIn: ["open", "in_progress", "done"],
          limit: 50,
        }),
      ]);
    } catch (err) {
      this.logger.warn("GenerateSummary: failed to query inputs", {
        channelId, err: String(err),
      });
      return null;
    }

    // Filter decisions/actions to the period by their timestamp
    const decisionsInPeriod = decisions.filter((d) => {
      const date = d.decidedAt ?? d.timestamp;
      return date >= periodStart && date <= periodEnd;
    });
    const actionsInPeriod = actions.filter(
      (a) => a.timestamp >= periodStart && a.timestamp <= periodEnd,
    );

    if (signals.length === 0 && decisionsInPeriod.length === 0 && actionsInPeriod.length === 0) {
      this.logger.info("GenerateSummary: no activity in period, skipping", { channelId, granularity });
      return null;
    }

    // Fetch prior summary for rolling context
    let priorSummary: string | null = null;
    try {
      const prior = await this.summaryRepo.findLatest(channelId, granularity);
      if (prior && prior.periodEnd < periodStart) {
        priorSummary = prior.summary;
      }
    } catch { /* non-fatal */ }

    // Call summarisation LLM
    let result;
    try {
      result = await this.summarise.summarise(
        channelId,
        signals.map((s) => ({
          signalType: s.signalType,
          summary: s.summary,
          occurredAt: s.occurredAt,
          participants: s.participants,
          tags: s.tags,
        })),
        decisionsInPeriod,
        actionsInPeriod,
        priorSummary,
        granularity,
      );
    } catch (err) {
      this.logger.warn("GenerateSummary: summarisation failed", { channelId, err: String(err) });
      return null;
    }

    // Persist
    try {
      return await this.summaryRepo.save({
        scopeType: "channel",
        scopeId: channelId,
        organisationId,
        periodStart,
        periodEnd,
        granularity,
        summary: result.summary,
        keyDecisions: result.keyDecisions,
        keyActions: result.keyActions,
        activeTopics: result.activeTopics,
        participants: result.participants,
        sentiment: result.sentiment,
        messageCount: result.messageCount,
        modelVersion: result.modelVersion,
      });
    } catch (err) {
      this.logger.warn("GenerateSummary: failed to persist summary", { channelId, err: String(err) });
      return null;
    }
  }
}
