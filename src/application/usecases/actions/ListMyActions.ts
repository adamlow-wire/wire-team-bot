import type { Action } from "../../../domain/entities/Action";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface ListMyActionsInput {
  conversationId: QualifiedId;
  assigneeId: QualifiedId;
  includeDone?: boolean;
  limit?: number;
  replyToMessageId?: string;
}

export class ListMyActions {
  constructor(
    private readonly actions: ActionRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: ListMyActionsInput): Promise<Action[]> {
    const statusIn: Action["status"][] = ["open", "in_progress", "overdue"];
    if (input.includeDone) statusIn.push("done");

    const list = await this.actions.query({
      conversationId: input.conversationId,
      assigneeId: input.assigneeId,
      statusIn,
      limit: input.limit ?? 20,
    });

    const byDeadline = [...list].sort((a, b) => {
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return a.deadline.getTime() - b.deadline.getTime();
    });

    const lines =
      byDeadline.length === 0
        ? ["No open actions for you in this conversation."]
        : byDeadline.map(
            (a) =>
              `- **${a.id}** \`${a.status}\` — ${a.description}${a.deadline ? ` _(due ${a.deadline.toISOString().slice(0, 10)})_` : ""}`,
          );

    await this.wireOutbound.sendPlainText(input.conversationId, lines.join("\n"), {
      replyToMessageId: input.replyToMessageId,
    });

    return list;
  }
}
