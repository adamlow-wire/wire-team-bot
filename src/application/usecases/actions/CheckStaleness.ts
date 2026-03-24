import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";

/** Actions not updated within this window are considered stale for nudge purposes. */
const LAST_CHECK_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Staleness detection — spec §8.1 and Phase 4.
 *
 * Queries all open/in_progress actions. For each that is either:
 *   - past its deadline, OR
 *   - past its stalenessAt timestamp
 * AND has not been status-checked within the last 24 hours:
 *
 * Posts a proactive Jeeves-voice nudge to the channel and updates last_status_check.
 *
 * This use-case is designed to be called by the InProcessScheduler (twice daily).
 */
export class CheckStaleness {
  constructor(
    private readonly actionRepo: ActionRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<void> {
    const now = new Date();
    const checkThreshold = new Date(now.getTime() - LAST_CHECK_THRESHOLD_MS);

    let openActions;
    try {
      openActions = await this.actionRepo.query({ statusIn: ["open", "in_progress"] });
    } catch (err) {
      this.logger.warn("CheckStaleness: failed to query actions", { err: String(err) });
      return;
    }

    // Filter to stale, not recently checked
    const stale = openActions.filter((a) => {
      if (a.deleted) return false;
      const recentlyChecked = a.lastStatusCheck && a.lastStatusCheck > checkThreshold;
      if (recentlyChecked) return false;
      const overdue = a.deadline && a.deadline < now;
      const stalenessTriggered = a.stalenessAt && a.stalenessAt < now;
      return overdue || stalenessTriggered;
    });

    if (stale.length === 0) return;

    // Group by channel (conversationId)
    const byChannel = new Map<string, typeof stale>();
    for (const action of stale) {
      const key = `${action.conversationId.id}@${action.conversationId.domain}`;
      const existing = byChannel.get(key);
      if (existing) {
        existing.push(action);
      } else {
        byChannel.set(key, [action]);
      }
    }

    for (const [, channelActions] of byChannel) {
      const convId = channelActions[0]!.conversationId;

      for (const action of channelActions) {
        const owner = action.assigneeName || action.assigneeId.id;
        const deadlineStr = action.deadline
          ? action.deadline.toISOString().slice(0, 10)
          : null;

        const daysLate = action.deadline
          ? Math.floor((now.getTime() - action.deadline.getTime()) / 86_400_000)
          : null;

        let nudge: string;
        if (daysLate !== null && daysLate > 0) {
          nudge =
            `If I may, ${owner} undertook to complete _${action.description}_ by ${deadlineStr}. ` +
            `That was ${daysLate} day${daysLate !== 1 ? "s" : ""} ago and I haven't noted any subsequent update. ` +
            `Shall I mark this as still in progress, or has it been resolved?`;
        } else {
          nudge =
            `One notes that _${action.description}_ (assigned to ${owner}) ` +
            `has had no update for some time. Shall I mark it as still in progress, or has it been resolved?`;
        }

        try {
          await this.wireOutbound.sendPlainText(convId, nudge);
        } catch (err) {
          this.logger.warn("CheckStaleness: failed to send nudge", {
            actionId: action.id, err: String(err),
          });
        }

        // Update last_status_check so we don't nudge again for 24 h
        try {
          await this.actionRepo.update({ ...action, lastStatusCheck: now });
        } catch (err) {
          this.logger.warn("CheckStaleness: failed to update last_status_check", {
            actionId: action.id, err: String(err),
          });
        }
      }
    }
  }
}
