/**
 * PendingActionStore — stores button-action state in Redis.
 *
 * When the pipeline or contradiction detector sends a composite prompt with
 * action buttons, it first stores metadata here so that onButtonActionReceived
 * knows what to do when a button is pressed.
 *
 * Key pattern:  jeeves:pending:<buttonId>
 * TTL:          300 seconds (5 minutes)
 */

import type { Redis } from "ioredis";

export type PendingActionKind =
  | "undo_decision"
  | "undo_action"
  | "supersede_decision"
  | "dismiss";

export interface PendingAction {
  kind: PendingActionKind;
  channelId: string;
  entityId: string;
  entityType: "decision" | "action";
  /** Additional data needed by the handler (e.g. superseding decision ID). */
  extraData?: Record<string, string>;
}

const TTL_SECONDS = 300;

export class PendingActionStore {
  private readonly prefix = "jeeves:pending";

  constructor(private readonly redis: Redis) {}

  async set(buttonId: string, action: PendingAction): Promise<void> {
    await this.redis.set(
      `${this.prefix}:${buttonId}`,
      JSON.stringify(action),
      "EX",
      TTL_SECONDS,
    );
  }

  async get(buttonId: string): Promise<PendingAction | null> {
    const raw = await this.redis.get(`${this.prefix}:${buttonId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PendingAction;
    } catch {
      return null;
    }
  }

  async del(buttonId: string): Promise<void> {
    await this.redis.del(`${this.prefix}:${buttonId}`);
  }
}
