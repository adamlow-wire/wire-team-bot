import type { Task } from "../../../domain/entities/Task";
import type { TaskRepository } from "../../../domain/repositories/TaskRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface ListMyTasksInput {
  conversationId: QualifiedId;
  assigneeId: QualifiedId;
  replyToMessageId?: string;
  statusFilter?: ("open" | "in_progress" | "done" | "cancelled")[];
}

export class ListMyTasks {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: ListMyTasksInput): Promise<Task[]> {
    const list = await this.tasks.query({
      conversationId: input.conversationId,
      assigneeId: input.assigneeId,
      statusIn: input.statusFilter ?? ["open", "in_progress"],
    });

    const lines =
      list.length === 0
        ? ["No open tasks for you in this conversation."]
        : list.map((t) => `- **${t.id}** \`${t.status}\` — ${t.description}${t.deadline ? ` _(due ${t.deadline.toISOString().slice(0, 10)})_` : ""}`);

    await this.wireOutbound.sendPlainText(input.conversationId, lines.join("\n"), {
      replyToMessageId: input.replyToMessageId,
    });

    return list;
  }
}
