import type { SignalType } from "../../application/ports/ExtractionPort";

export interface SourceRef {
  wire_msg_ids: string[];
  timestamp_range: { start: string; end: string };
}

export interface NewConversationSignal {
  channelId: string;
  orgId: string;
  signalType: SignalType;
  /** 1–2 sentences synthesised — NO verbatim message content. */
  summary: string;
  participants: string[];
  tags: string[];
  occurredAt: Date;
  confidence: number;
  sourceRef: SourceRef;
}

export interface ConversationSignalRecord {
  id: string;
  channelId: string;
  organisationId: string;
  signalType: string;
  summary: string;
  participants: string[];
  tags: string[];
  occurredAt: Date;
  confidence: number;
}

export interface ConversationSignalRepository {
  create(signal: NewConversationSignal): Promise<void>;
  /** Query signals for a channel within a time window (inclusive). */
  query(channelId: string, start: Date, end: Date): Promise<ConversationSignalRecord[]>;
}
