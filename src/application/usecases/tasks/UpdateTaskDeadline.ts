import type { Task } from "../../../domain/entities/Task";
import type { TaskRepository } from "../../../domain/repositories/TaskRepository";
import type { DateTimeService } from "../../../domain/services/DateTimeService";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface UpdateTaskDeadlineInput {
  taskId: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  deadlineText: string;
  timezone: string;
  replyToMessageId?: string;
}

export class UpdateTaskDeadline {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly dateTimeService: DateTimeService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: UpdateTaskDeadlineInput): Promise<Task | null> {
    const task = await this.tasks.findById(input.taskId);
    if (!task || task.conversationId.id !== input.conversationId.id) {
      return null;
    }

    const parsed = this.dateTimeService.parse(input.deadlineText, {
      timezone: input.timezone,
    });

    if (!parsed) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        `Could not parse date/time: "${input.deadlineText}". Please try again with a clearer expression.`,
        { replyToMessageId: input.replyToMessageId },
      );
      return null;
    }

    const newDeadline = parsed.value;
    const updated: Task = {
      ...task,
      deadline: newDeadline,
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
      details: { deadline: newDeadline },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `**${task.id}** deadline set to **${newDeadline.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}**.`,
      { replyToMessageId: input.replyToMessageId },
    );

    return updated;
  }
}
