export type ChannelState = "active" | "paused" | "secure";

export type ContextType = "customer" | "project" | "team" | "general";

export interface SecureRange {
  start: Date;
  end: Date | null;
}

export interface ChannelConfig {
  /** "{conversationId}@{conversationDomain}" */
  channelId: string;
  channelName?: string;
  /** Wire domain string, e.g. "wire.com" */
  organisationId: string;
  state: ChannelState;
  stateChangedAt?: Date;
  /** Wire user ID of the actor who last changed state. */
  stateChangedBy?: string;
  purpose?: string;
  contextType?: ContextType;
  tags?: string[];
  stakeholders?: string[];
  relatedChannels?: string[];
  contextUpdatedAt?: Date;
  contextUpdatedBy?: string;
  /** JSONB array of secure periods; used to avoid cross-contaminating context. */
  secureRanges: SecureRange[];
  timezone: string;
  locale: string;
  joinedAt?: Date;
  /**
   * True when the conversation has exactly one non-bot member.
   * Updated on member join/leave events. Enables personal-mode org-wide queries.
   */
  isPersonalMode?: boolean;
}

export interface ChannelConfigRepository {
  get(channelId: string): Promise<ChannelConfig | null>;
  upsert(config: ChannelConfig): Promise<ChannelConfig>;
  /** Atomically set state + stateChangedAt + stateChangedBy. */
  setState(channelId: string, state: ChannelState, changedBy: string, now: Date): Promise<void>;
  /** Append a new secure range (open-ended until closeSecureRange is called). */
  openSecureRange(channelId: string, start: Date): Promise<void>;
  /** Close the most recent open secure range. */
  closeSecureRange(channelId: string, end: Date): Promise<void>;
}
