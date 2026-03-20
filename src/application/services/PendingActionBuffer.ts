import type { QualifiedId } from "../../domain/ids/QualifiedId";

export interface PendingAction {
  description: string;
  authorId: QualifiedId;
  rawMessage: string;
  rawMessageId: string;
  capturedAt: Date;
  /** Message count in the conversation at the time of capture. */
  baseMessageCount: number;
  /** Assignee reference extracted from the capture, if any. */
  assigneeReference?: string;
  /** Deadline text extracted from the capture, if any. */
  deadlineText?: string;
}

const MATURITY_MESSAGES = 3;
const MATURITY_MS = 5 * 60 * 1000; // 5 minutes

/** Words in subsequent messages that suggest the action is already resolved. */
const RESOLUTION_RE = /\b(never\s*mind|sorted|already\s+done|forget\s+(it|that)|we\s+don'?t\s+need|not\s+needed|that'?s\s+done|i'?ll\s+do\s+it|on\s+it|i'?m\s+on\s+it|handled|taken\s+care)\b/i;

/**
 * In-memory buffer for action candidates detected in ambient speech.
 * Actions are held until 3 subsequent messages or 5 minutes have elapsed,
 * at which point they are considered mature and ready to be persisted.
 * If intervening messages contain resolution signals the action is discarded.
 */
export class PendingActionBuffer {
  private readonly buffer = new Map<string, PendingAction[]>();
  private readonly msgCount = new Map<string, number>();
  private readonly recentTexts = new Map<string, string[]>();

  private key(convId: QualifiedId): string {
    return `${convId.id}@${convId.domain}`;
  }

  /** Record that a new message arrived in this conversation. */
  tick(convId: QualifiedId, text: string): void {
    const k = this.key(convId);
    this.msgCount.set(k, (this.msgCount.get(k) ?? 0) + 1);
    const texts = this.recentTexts.get(k) ?? [];
    texts.push(text);
    if (texts.length > 20) texts.shift();
    this.recentTexts.set(k, texts);
  }

  /** Add a detected action to the buffer. */
  add(convId: QualifiedId, action: Omit<PendingAction, "baseMessageCount">): void {
    const k = this.key(convId);
    const pending = this.buffer.get(k) ?? [];
    pending.push({ ...action, baseMessageCount: this.msgCount.get(k) ?? 0 });
    this.buffer.set(k, pending);
  }

  /**
   * Returns actions that have matured and removes them from the buffer.
   * Actions whose topic appears resolved in subsequent messages are discarded.
   */
  popMatured(convId: QualifiedId): PendingAction[] {
    const k = this.key(convId);
    const pending = this.buffer.get(k) ?? [];
    const currentCount = this.msgCount.get(k) ?? 0;
    const now = Date.now();
    const texts = this.recentTexts.get(k) ?? [];

    const matured: PendingAction[] = [];
    const remaining: PendingAction[] = [];

    for (const action of pending) {
      const elapsed = currentCount - action.baseMessageCount;
      const age = now - action.capturedAt.getTime();
      if (elapsed >= MATURITY_MESSAGES || age >= MATURITY_MS) {
        // Check messages received AFTER the action was detected for resolution signals
        const subsequentTexts = texts.slice(-(elapsed + 1));
        if (!subsequentTexts.some((t) => RESOLUTION_RE.test(t))) {
          matured.push(action);
        }
        // Either way, remove from buffer — resolved or stored, it's done
      } else {
        remaining.push(action);
      }
    }

    if (pending.length !== remaining.length) {
      this.buffer.set(k, remaining);
    }
    return matured;
  }

  clearConversation(convId: QualifiedId): void {
    const k = this.key(convId);
    this.buffer.delete(k);
    this.msgCount.delete(k);
    this.recentTexts.delete(k);
  }
}
