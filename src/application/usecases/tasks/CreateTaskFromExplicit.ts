import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { Task, TaskPriority, TaskStatus } from "../../../domain/entities/Task";
import type { TaskRepository } from "../../../domain/repositories/TaskRepository";
import type { ConversationConfigRepository } from "../../../domain/repositories/ConversationConfigRepository";
import type { DateTimeService } from "../../../domain/services/DateTimeService";
import type { UserResolutionService } from "../../../domain/services/UserResolutionService";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";

export interface CreateTaskFromExplicitInput {
  conversationId: QualifiedId;
  authorId: QualifiedId;
  authorName: string;
  rawMessageId: string;
  rawMessage: string;

  description: string;
  assigneeReference?: string;
  deadlineText?: string;
  priority?: TaskPriority;
}

export class CreateTaskFromExplicit {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly conversationConfig: ConversationConfigRepository,
    private readonly dateTimeService: DateTimeService,
    private readonly userResolutionService: UserResolutionService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  public async execute(input: CreateTaskFromExplicitInput): Promise<Task> {
    const now = new Date();
    const id = await this.tasks.nextId();

    const assigneeResult = await this.resolveAssignee(input);
    const assigneeId = assigneeResult.userId ?? input.authorId;
    const assigneeName = assigneeResult.userId ? input.assigneeReference ?? input.authorName : input.authorName;

    const deadline = await this.parseDeadline(input.deadlineText, input.conversationId);

    const task: Task = {
      // shared fields
      id,
      conversationId: input.conversationId,
      authorId: input.authorId,
      authorName: input.authorName,
      rawMessageId: input.rawMessageId,
      rawMessage: input.rawMessage,
      timestamp: now,
      updatedAt: now,
      tags: [],
      deleted: false,
      version: 1,
      // task-specific
      description: input.description,
      assigneeId,
      assigneeName,
      creatorId: input.authorId,
      deadline,
      status: "open",
      priority: input.priority ?? "normal",
      recurrence: null,
      linkedIds: [],
      completionNote: null,
    };

    const saved = await this.tasks.create(task);

    await this.auditLog.append({
      timestamp: now,
      actorId: input.authorId,
      conversationId: input.conversationId,
      action: "entity_created",
      entityType: "Task",
      entityId: saved.id,
      details: { description: saved.description, assigneeId: assigneeId },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `Created task ${saved.id} for ${assigneeName}: ${saved.description}`,
      { replyToMessageId: input.rawMessageId },
    );

    return saved;
  }

  private async resolveAssignee(
    input: CreateTaskFromExplicitInput,
  ): Promise<Awaited<ReturnType<UserResolutionService["resolveByHandleOrName"]>>> {
    if (!input.assigneeReference) {
      return {
        userId: input.authorId,
        ambiguous: false,
      };
    }

    return this.userResolutionService.resolveByHandleOrName(input.assigneeReference, {
      conversationId: input.conversationId,
    });
  }

  private async parseDeadline(deadlineText: string | undefined, conversationId: QualifiedId): Promise<Date | null> {
    if (!deadlineText) return null;
    const config = await this.conversationConfig.get(conversationId);
    const timezone = config?.timezone ?? "UTC";
    const parsed = this.dateTimeService.parse(deadlineText, { timezone });
    if (!parsed) return null;
    return parsed.value;
  }
}

