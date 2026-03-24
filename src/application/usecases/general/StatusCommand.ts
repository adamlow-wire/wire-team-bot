import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { ChannelConfigRepository } from "../../../domain/repositories/ChannelConfigRepository";
import type { EntityRepository } from "../../../domain/repositories/EntityRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface StatusCommandInput {
  conversationId: QualifiedId;
  channelId: string;
  replyToMessageId: string;
}

/**
 * Reports the current channel status in Jeeves voice:
 * - Channel state (active / paused / secure)
 * - Time active since joining
 * - Number of entities tracked in the knowledge graph
 * - Channel purpose (if set)
 * - Context type / tags (if set)
 */
export class StatusCommand {
  constructor(
    private readonly channelConfig: ChannelConfigRepository,
    private readonly entityRepo: EntityRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: StatusCommandInput): Promise<void> {
    const cfg = await this.channelConfig.get(input.channelId);
    const entityNames = await this.entityRepo.listNames(input.channelId);

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

    lines.push(`Entities tracked: ${entityNames.length}`);

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
