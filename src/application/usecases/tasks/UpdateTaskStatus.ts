import type { Task, TaskStatus } from "../../../domain/entities/Task";
import type { TaskRepository } from "../../../domain/repositories/TaskRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface UpdateTaskStatusInput {
  taskId: string;
  newStatus: TaskStatus;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  completionNote?: string;
  replyToMessageId?: string;
}

export class UpdateTaskStatus {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: UpdateTaskStatusInput): Promise<Task | null> {
    const task = await this.tasks.findById(input.taskId);
    if (!task || task.conversationId.id !== input.conversationId.id) return null;

    const updated: Task = {
      ...task,
      status: input.newStatus,
      updatedAt: new Date(),
      version: task.version + 1,
      completionNote:
        input.newStatus === "done" ? (input.completionNote ?? task.completionNote ?? null) : task.completionNote ?? null,
    };

    await this.tasks.update(updated);

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Task",
      entityId: updated.id,
      details: { newStatus: input.newStatus },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `${updated.id} marked as ${input.newStatus}.`,
      { replyToMessageId: input.replyToMessageId },
    );

    return updated;
  }
}
