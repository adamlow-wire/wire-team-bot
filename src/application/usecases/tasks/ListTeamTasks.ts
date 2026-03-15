import type { Task } from "../../../domain/entities/Task";
import type { TaskRepository } from "../../../domain/repositories/TaskRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface ListTeamTasksInput {
  conversationId: QualifiedId;
  replyToMessageId?: string;
}

export class ListTeamTasks {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: ListTeamTasksInput): Promise<Task[]> {
    const list = await this.tasks.query({
      conversationId: input.conversationId,
      statusIn: ["open", "in_progress"],
      limit: 30,
    });

    const byAssignee = new Map<string, Task[]>();
    for (const t of list) {
      const key = `${t.assigneeId.id}@${t.assigneeId.domain}`;
      if (!byAssignee.has(key)) byAssignee.set(key, []);
      byAssignee.get(key)!.push(t);
    }

    // Sort each group by deadline (nulls last)
    for (const [, tasks] of byAssignee) {
      tasks.sort((a, b) => {
        if (!a.deadline && !b.deadline) return 0;
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return a.deadline.getTime() - b.deadline.getTime();
      });
    }

    const lines: string[] = [];
    if (list.length === 0) {
      lines.push("No open tasks in this conversation.");
    } else {
      for (const [, tasks] of byAssignee) {
        const name = tasks[0].assigneeName || tasks[0].assigneeId.id;
        lines.push(`**${name}**`);
        for (const t of tasks) {
          lines.push(
            `- **${t.id}** \`${t.status}\` — ${t.description}${t.deadline ? ` _(due ${t.deadline.toISOString().slice(0, 10)})_` : ""}`,
          );
        }
      }
    }

    await this.wireOutbound.sendPlainText(input.conversationId, lines.join("\n"), {
      replyToMessageId: input.replyToMessageId,
    });

    return list;
  }
}
