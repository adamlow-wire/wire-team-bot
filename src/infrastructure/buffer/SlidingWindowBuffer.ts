/**
 * In-memory sliding window ring buffer per channel.
 *
 * Holds up to MAX_WINDOW_SIZE messages per channel, dropping the oldest
 * when full. Flushed immediately when a channel enters SECURE state so
 * that no context from before a secure period leaks into extraction.
 *
 * Deliberately in-process and non-durable: loss on restart is correct
 * behaviour — extraction quality degrades briefly then recovers.
 */

export interface WindowMessage {
  messageId: string;
  authorId: string;
  authorName?: string;
  text: string;
  timestamp: Date;
}

const MAX_WINDOW_SIZE = 30;

export class SlidingWindowBuffer {
  private readonly windows = new Map<string, WindowMessage[]>();

  push(channelId: string, message: WindowMessage): void {
    const window = this.windows.get(channelId) ?? [];
    window.push(message);
    if (window.length > MAX_WINDOW_SIZE) {
      window.shift();
    }
    this.windows.set(channelId, window);
  }

  getWindow(channelId: string): WindowMessage[] {
    return this.windows.get(channelId) ?? [];
  }

  /** Flush all messages for a channel. Called on SECURE state entry. */
  flush(channelId: string): void {
    this.windows.delete(channelId);
  }

  clear(channelId: string): void {
    this.windows.delete(channelId);
  }
}
