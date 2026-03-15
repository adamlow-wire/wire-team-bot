export type IntentType =
  | "create_task"
  | "update_task"
  | "update_task_status"
  | "create_decision"
  | "supersede_decision"
  | "create_action"
  | "update_action"
  | "update_action_status"
  | "reassign_action"
  | "create_reminder"
  | "cancel_reminder"
  | "snooze_reminder"
  | "store_knowledge"
  | "update_knowledge"
  | "delete_knowledge"
  | "retrieve_knowledge"
  | "list_my_tasks"
  | "list_team_tasks"
  | "list_decisions"
  | "list_my_actions"
  | "list_team_actions"
  | "list_overdue_actions"
  | "list_reminders"
  | "help"
  | "secret_mode_on"
  | "secret_mode_off"
  | "none";

export interface IntentPayload {
  description?: string;
  summary?: string;
  detail?: string;
  assignee?: string;
  deadline?: string;
  priority?: string;
  timeExpression?: string;
  query?: string;
  usePreviousMessage?: boolean;
  entityId?: string;
  newStatus?: string;
  newAssignee?: string;
  newDeadline?: string;
  newPriority?: string;
  newSummary?: string;
  newDetail?: string;
  snoozeExpression?: string;
  supersedesId?: string;
}

export interface IntentResult {
  intent: IntentType;
  payload: IntentPayload;
  confidence: number;
}

export interface IntentClassifierService {
  classify(text: string, previousMessageText?: string): Promise<IntentResult>;
}
