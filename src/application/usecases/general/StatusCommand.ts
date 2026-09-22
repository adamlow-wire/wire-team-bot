import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { ChannelConfigRepository } from "../../../domain/repositories/ChannelConfigRepository";
import type { EntityRepository } from "../../../domain/repositories/EntityRepository";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { ReminderRepository } from "../../../domain/repositories/ReminderRepository";
import type { DecisionRepository } from "../../../domain/repositories/DecisionRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface StatusCommandInput {
  conversationId: QualifiedId;
  channelId: string;
  replyToMessageId: string;
}

/** Rows fetched per record type. A count that reaches the cap is shown as "N+". */
const COUNT_CAP = 100;

/**
 * Reports the current channel status in Wire Team Bot voice:
 * - Channel state (active / paused / secure)
 * - Time active since joining
 * - Open actions, pending reminders and active decisions in this conversation
 * - Number of knowledge graph entities (written only by passive extraction)
 * - Channel purpose (if set)
 * - Context type / tags (if set)
 */
export class StatusCommand {
  constructor(
    private readonly channelConfig: ChannelConfigRepository,
    private readonly entityRepo: EntityRepository,
    private readonly actionRepo: ActionRepository,
    private readonly reminderRepo: ReminderRepository,
    private readonly decisionRepo: DecisionRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: StatusCommandInput): Promise<void> {
    const conversationId = input.conversationId;
    const [cfg, entityNames, actions, reminders, decisions] = await Promise.all([
      this.channelConfig.get(input.channelId),
      this.entityRepo.listNames(input.channelId),
      // Same status sets as `team actions`, `show reminders` and `list decisions`.
      this.actionRepo.query({ conversationId, statusIn: ["open", "in_progress", "overdue"], limit: COUNT_CAP }),
      this.reminderRepo.query({ conversationId, statusIn: ["pending"] }),
      this.decisionRepo.query({ conversationId, statusIn: ["active"], limit: COUNT_CAP }),
    ]);

    const state = cfg?.state ?? "active";
    const stateLabel: Record<string, string> = {
      active: "active — I am at your service",
      paused: "paused — I am standing by",
      secure: "secure — I am not listening",
    };

    const lines: string[] = [`**Channel status**`, ``, `State: ${stateLabel[state] ?? state}`];

    if (cfg?.joinedAt) {
      const ageMs = Date.now() - cfg.joinedAt.getTime();
      const days = Math.floor(ageMs / 86_400_000);
      if (days > 0) {
        lines.push(`Active for: ${days} day${days !== 1 ? "s" : ""}`);
      } else {
        const hours = Math.floor(ageMs / 3_600_000);
        lines.push(`Active for: ${hours} hour${hours !== 1 ? "s" : ""}`);
      }
    }

    lines.push(
      `Open actions: ${formatCount(actions, true)}`,
      // The reminder query takes no limit, so its count is always exact.
      `Pending reminders: ${formatCount(reminders, false)}`,
      `Active decisions: ${formatCount(decisions, true)}`,
      `Knowledge graph entities: ${entityNames.length}`,
    );

    if (cfg?.purpose) {
      lines.push(``, `Purpose: ${cfg.purpose}`);
    }

    if (cfg?.contextType) {
      lines.push(`Context type: ${cfg.contextType}`);
    }

    if (cfg?.tags && cfg.tags.length > 0) {
      lines.push(`Tags: ${cfg.tags.join(", ")}`);
    }

    if (cfg?.stateChangedAt) {
      lines.push(``, `State last changed: ${cfg.stateChangedAt.toISOString().slice(0, 10)}`);
    }

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      lines.join("\n"),
      { replyToMessageId: input.replyToMessageId },
    );
  }
}

/**
 * Counts non-deleted records. For a capped query, a full page means more rows may exist,
 * so the cap is checked on the raw result and the count is shown as "N+".
 */
function formatCount(records: Array<{ deleted: boolean }>, capped: boolean): string {
  const count = records.filter((r) => !r.deleted).length;
  return capped && records.length >= COUNT_CAP ? `${count}+` : `${count}`;
}
