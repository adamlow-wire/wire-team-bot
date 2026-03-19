import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { KnowledgeRepository } from "../../../domain/repositories/KnowledgeRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";

export interface ListKnowledgeInput {
  conversationId: QualifiedId;
  limit?: number;
  replyToMessageId?: string;
}

export class ListKnowledge {
  constructor(
    private readonly knowledge: KnowledgeRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: ListKnowledgeInput): Promise<void> {
    const limit = input.limit ?? 15;
    const entries = await this.knowledge.query({
      conversationId: input.conversationId,
      limit,
    });

    if (entries.length === 0) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        "No knowledge stored in this conversation yet.",
        { replyToMessageId: input.replyToMessageId },
      );
      return;
    }

    const lines = entries.map(
      (e) =>
        `- **${e.id}** — ${e.summary} _(${e.confidence}, ${e.updatedAt.toISOString().slice(0, 10)})_`,
    );

    const header = entries.length === limit
      ? `**Knowledge** _(most recent ${limit})_`
      : `**Knowledge** _(${entries.length} entries)_`;

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `${header}\n\n${lines.join("\n")}`,
      { replyToMessageId: input.replyToMessageId },
    );
  }
}
