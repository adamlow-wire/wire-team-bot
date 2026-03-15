import type { Action } from "../../../domain/entities/Action";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface ListOverdueActionsInput {
  conversationId: QualifiedId;
  replyToMessageId?: string;
}

export class ListOverdueActions {
  constructor(
    private readonly actions: ActionRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: ListOverdueActionsInput): Promise<Action[]> {
    const now = new Date();

    const [overdueByStatus, overdueByDeadline] = await Promise.all([
      this.actions.query({
        conversationId: input.conversationId,
        statusIn: ["overdue"],
      }),
      this.actions.query({
        conversationId: input.conversationId,
        statusIn: ["open", "in_progress"],
        deadlineBefore: now,
      }),
    ]);

    // Combine and deduplicate by id
    const seen = new Set<string>();
    const combined: Action[] = [];
    for (const a of [...overdueByStatus, ...overdueByDeadline]) {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        combined.push(a);
      }
    }

    const byAssignee = new Map<string, Action[]>();
    for (const a of combined) {
      const key = `${a.assigneeId.id}@${a.assigneeId.domain}`;
      if (!byAssignee.has(key)) byAssignee.set(key, []);
      byAssignee.get(key)!.push(a);
    }

    const lines: string[] = [];
    if (combined.length === 0) {
      lines.push("No overdue actions.");
    } else {
      lines.push("**Overdue Actions**");
      for (const [, actions] of byAssignee) {
        const name = actions[0].assigneeName || actions[0].assigneeId.id;
        lines.push(`**${name}**`);
        for (const a of actions) {
          lines.push(
            `- **${a.id}** \`${a.status}\` — ${a.description}${a.deadline ? ` _(due ${a.deadline.toISOString().slice(0, 10)})_` : ""}`,
          );
        }
      }
    }

    await this.wireOutbound.sendPlainText(input.conversationId, lines.join("\n"), {
      replyToMessageId: input.replyToMessageId,
    });

    return combined;
  }
}
