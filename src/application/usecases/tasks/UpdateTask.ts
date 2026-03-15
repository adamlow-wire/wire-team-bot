import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { TaskStatus, TaskPriority } from "../../../domain/entities/Task";
import type { TaskRepository } from "../../../domain/repositories/TaskRepository";
import type { ConversationConfigRepository } from "../../../domain/repositories/ConversationConfigRepository";
import type { DateTimeService } from "../../../domain/services/DateTimeService";
import type { UserResolutionService } from "../../../domain/services/UserResolutionService";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";

export interface UpdateTaskInput {
  taskId: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  replyToMessageId?: string;
  newStatus?: TaskStatus;
  newAssigneeReference?: string;
  newDeadlineText?: string;
  newPriority?: TaskPriority;
}

export class UpdateTask {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly conversationConfig: ConversationConfigRepository,
    private readonly dateTimeService: DateTimeService,
    private readonly userResolution: UserResolutionService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: UpdateTaskInput): Promise<void> {
    const task = await this.tasks.findById(input.taskId);
    if (!task || task.conversationId.id !== input.conversationId.id) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        `Task \`${input.taskId}\` not found in this conversation.`,
        { replyToMessageId: input.replyToMessageId },
      );
      return;
    }

    const now = new Date();
    const changes: string[] = [];
    let updated = { ...task, updatedAt: now, version: task.version + 1 };

    if (input.newStatus) {
      updated = { ...updated, status: input.newStatus };
      changes.push(`status → \`${input.newStatus}\``);
    }

    if (input.newPriority) {
      updated = { ...updated, priority: input.newPriority };
      changes.push(`priority → \`${input.newPriority}\``);
    }

    if (input.newAssigneeReference) {
      const resolved = await this.userResolution.resolveByHandleOrName(input.newAssigneeReference, {
        conversationId: input.conversationId,
      });
      if (!resolved.userId || resolved.ambiguous) {
        await this.wireOutbound.sendPlainText(
          input.conversationId,
          resolved.ambiguous ? "Multiple users match; please use @mention." : "Could not resolve assignee.",
          { replyToMessageId: input.replyToMessageId },
        );
        return;
      }
      const oldName = updated.assigneeName;
      updated = { ...updated, assigneeId: resolved.userId, assigneeName: input.newAssigneeReference };
      changes.push(`assignee: **${oldName}** → **${input.newAssigneeReference}**`);
    }

    if (input.newDeadlineText) {
      const config = await this.conversationConfig.get(input.conversationId);
      const timezone = config?.timezone ?? "UTC";
      const parsed = this.dateTimeService.parse(input.newDeadlineText, { timezone });
      if (!parsed?.value) {
        await this.wireOutbound.sendPlainText(
          input.conversationId,
          `Sorry, I couldn't parse "${input.newDeadlineText}" as a date.`,
          { replyToMessageId: input.replyToMessageId },
        );
        return;
      }
      updated = { ...updated, deadline: parsed.value };
      changes.push(`deadline → _${parsed.value.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}_`);
    }

    if (changes.length === 0) return;

    await this.tasks.update(updated);
    await this.auditLog.append({
      timestamp: now,
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Task",
      entityId: task.id,
      details: { changes },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `**${task.id}** updated: ${changes.join(", ")}.`,
      { replyToMessageId: input.replyToMessageId },
    );
  }
}
