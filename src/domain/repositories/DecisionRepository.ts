import type { Decision, DecisionStatus } from "../entities/Decision";
import type { QualifiedId } from "../ids/QualifiedId";

export interface DecisionQuery {
  conversationId?: QualifiedId;
  authorId?: QualifiedId;
  statusIn?: DecisionStatus[];
  searchText?: string;
  limit?: number;
}

export interface DecisionRepository {
  create(decision: Decision): Promise<Decision>;
  update(decision: Decision): Promise<Decision>;
  findById(id: string): Promise<Decision | null>;
  findByContentHash(channelId: string, hash: string): Promise<Decision | null>;
  query(criteria: DecisionQuery): Promise<Decision[]>;
  nextId(): Promise<string>;
}
