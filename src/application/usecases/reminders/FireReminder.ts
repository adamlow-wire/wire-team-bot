import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { SchedulerPort } from "../../ports/SchedulerPort";
import type { ReminderRepository } from "../../../domain/repositories/ReminderRepository";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface FireReminderInput { reminderId: string; }

/** Delivery is at least once: a crash after send but before update can duplicate it. */
export class FireReminder {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly reminders: ReminderRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
    private readonly systemActorId: QualifiedId,
    private readonly scheduler: SchedulerPort,
  ) {}

  async execute(input: FireReminderInput): Promise<void> {
    if (this.inFlight.has(input.reminderId)) return;
    this.inFlight.add(input.reminderId);
    try {
      const reminder = await this.reminders.findById(input.reminderId);
      if (!reminder || reminder.deleted || reminder.status !== "pending" || !reminder.conversationId) return;
      // A snooze may have overtaken an already dispatched callback.
      if (reminder.triggerAt.getTime() > Date.now()) {
        this.schedule(reminder.id, reminder.triggerAt);
        return;
      }
      await this.wireOutbound.sendPlainText(reminder.conversationId, `**Reminder ${reminder.id}:** ${reminder.description}`);
      await this.reminders.update({ ...reminder, status: "fired", updatedAt: new Date(), version: reminder.version + 1 });
      await this.auditLog.append({ timestamp: new Date(), actorId: this.systemActorId,
        conversationId: reminder.conversationId, action: "entity_updated", entityType: "Reminder",
        entityId: reminder.id, details: { status: "fired" } });
    } catch (err) {
      // Pending remains durable and startup rehydrates overdue work. Also retry without restart.
      this.schedule(input.reminderId, new Date(Date.now() + 60_000));
      throw err;
    } finally {
      this.inFlight.delete(input.reminderId);
    }
  }

  private schedule(reminderId: string, runAt: Date): void {
    this.scheduler.schedule({ id: `rem-${reminderId}`, type: "reminder", runAt, payload: { reminderId } });
  }
}
