import type { Action, ActionStatus } from "../entities/Action";
import type { QualifiedId } from "../ids/QualifiedId";

export interface ActionQuery {
  conversationId?: QualifiedId;
  assigneeId?: QualifiedId;
  creatorId?: QualifiedId;
  statusIn?: ActionStatus[];
  searchText?: string;
  limit?: number;
  deadlineBefore?: Date;
}

export interface ActionRepository {
  create(action: Action): Promise<Action>;
  update(action: Action): Promise<Action>;
  findById(id: string): Promise<Action | null>;
  findByContentHash(channelId: string, hash: string): Promise<Action | null>;
  query(criteria: ActionQuery): Promise<Action[]>;
  nextId(): Promise<string>;
}
