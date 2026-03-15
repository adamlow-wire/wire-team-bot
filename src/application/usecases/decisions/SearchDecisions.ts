import type { Decision } from "../../../domain/entities/Decision";
import type { DecisionRepository } from "../../../domain/repositories/DecisionRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface SearchDecisionsInput {
  conversationId: QualifiedId;
  searchText: string;
  limit?: number;
  replyToMessageId?: string;
}

export class SearchDecisions {
  constructor(
    private readonly decisions: DecisionRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: SearchDecisionsInput): Promise<Decision[]> {
    const list = await this.decisions.query({
      conversationId: input.conversationId,
      searchText: input.searchText,
      statusIn: ["active"],
      limit: input.limit ?? 10,
    });

    const lines =
      list.length === 0
        ? ["No matching decisions."]
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
