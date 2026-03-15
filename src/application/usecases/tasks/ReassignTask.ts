import type { Task } from "../../../domain/entities/Task";
import type { TaskRepository } from "../../../domain/repositories/TaskRepository";
import type { UserResolutionService } from "../../../domain/services/UserResolutionService";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface ReassignTaskInput {
  taskId: string;
  conversationId: QualifiedId;
  newAssigneeReference: string;
  actorId: QualifiedId;
  replyToMessageId?: string;
}

export class ReassignTask {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly userResolution: UserResolutionService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: ReassignTaskInput): Promise<Task | null> {
    const task = await this.tasks.findById(input.taskId);
    if (!task || task.conversationId.id !== input.conversationId.id) {
      return null;
    }

    const resolved = await this.userResolution.resolveByHandleOrName(
      input.newAssigneeReference,
      { conversationId: input.conversationId },
    );

    if (!resolved.userId || resolved.ambiguous) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        resolved.ambiguous
          ? "Multiple users match; please use @mention."
          : "Could not resolve assignee.",
        { replyToMessageId: input.replyToMessageId },
      );
      return null;
    }

    const previousAssigneeName = task.assigneeName;
    const updated: Task = {
      ...task,
      assigneeId: resolved.userId,
      assigneeName: input.newAssigneeReference,
      updatedAt: new Date(),
      version: task.version + 1,
    };

    await this.tasks.update(updated);

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Task",
      entityId: task.id,
      details: { reassignedTo: input.newAssigneeReference },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `**${task.id}** reassigned from **${previousAssigneeName}** to **${input.newAssigneeReference}**.`,
      { replyToMessageId: input.replyToMessageId },
    );

    return updated;
  }
}
