import type { Decision } from "../../../domain/entities/Decision";
import type { DecisionRepository } from "../../../domain/repositories/DecisionRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface ListDecisionsInput {
  conversationId: QualifiedId;
  limit?: number;
  replyToMessageId?: string;
}

export class ListDecisions {
  constructor(
    private readonly decisions: DecisionRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: ListDecisionsInput): Promise<Decision[]> {
    const list = await this.decisions.query({
      conversationId: input.conversationId,
      statusIn: ["active"],
      limit: input.limit ?? 15,
    });

    const lines =
      list.length === 0
        ? ["No recent decisions in this conversation."]
        : list.map(
            (d) =>
              `- **${d.id}** — ${d.summary} _(${d.timestamp.toISOString().slice(0, 10)})_`,
          );

    await this.wireOutbound.sendPlainText(input.conversationId, lines.join("\n"), {
      replyToMessageId: input.replyToMessageId,
    });

    return list;
  }
}
