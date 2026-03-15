import type { QualifiedId } from "../ids/QualifiedId";

/**
 * Base type for all domain events. Domain events are used for internal
 * signalling between bounded contexts (e.g. triggering audit log writes,
 * scheduling follow-up work). They are not persisted directly.
 */
export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Date;
  readonly conversationId?: QualifiedId;
}

export interface TaskCreated extends DomainEvent {
  readonly type: "TaskCreated";
  readonly taskId: string;
  readonly authorId: QualifiedId;
}

export interface DecisionLogged extends DomainEvent {
  readonly type: "DecisionLogged";
  readonly decisionId: string;
  readonly authorId: QualifiedId;
}

export interface ActionCreated extends DomainEvent {
  readonly type: "ActionCreated";
  readonly actionId: string;
  readonly assigneeId: QualifiedId;
}

export interface KnowledgeStored extends DomainEvent {
  readonly type: "KnowledgeStored";
  readonly knowledgeId: string;
  readonly authorId: QualifiedId;
}

export interface ReminderFired extends DomainEvent {
  readonly type: "ReminderFired";
  readonly reminderId: string;
}
