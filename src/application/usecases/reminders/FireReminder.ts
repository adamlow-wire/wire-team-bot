import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { ReminderRepository } from "../../../domain/repositories/ReminderRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface FireReminderInput {
  reminderId: string;
}

/**
 * Invoked by the scheduler when a reminder's trigger time is reached.
 * Marks the reminder as fired and sends a message to its conversation.
 */
export class FireReminder {
  constructor(
    private readonly reminders: ReminderRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly systemActorId: QualifiedId,
  ) {}

  async execute(input: FireReminderInput): Promise<void> {
    const reminder = await this.reminders.findById(input.reminderId);
    if (!reminder || reminder.status !== "pending") return;

    const updated = { ...reminder, status: "fired" as const, updatedAt: new Date() };
    await this.reminders.update(updated);

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: this.systemActorId,
      conversationId: reminder.conversationId ?? undefined,
      action: "entity_updated",
      entityType: "Reminder",
      entityId: reminder.id,
      details: { status: "fired" },
    });

    const convId = reminder.conversationId;
    const text = `Reminder: ${reminder.description}`;
    await this.wireOutbound.sendPlainText(convId, text);
  }
}
