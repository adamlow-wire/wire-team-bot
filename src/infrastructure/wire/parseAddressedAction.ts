interface AddressedAction {
  assigneeReference: string;
  description: string;
  deadlineText?: string;
}

/** A bounded command variant, not a general intent or multi-action parser. */
export function parseAddressedAction(text: string): AddressedAction | null {
  if (/[?`"“”\r\n]/.test(text) || /\b(if|unless|maybe|perhaps|might|could|would|should|not|never)\b|n't\b|\bno longer\b/i.test(text)) return null;

  // The optional project deadline is surrounding context, never the action's
  // deadline or an instruction to assign another action to the sender.
  const match = text.match(/^(?:we(?:\s+really)?\s+need\s+to\s+(?:get\s+[^,;]+?\s+done|(?:finish|complete)\s+[^,;]+?)\s+by\s+[^,;]+[,;]\s*)?(@[^,;]+?)\s+(?:really\s+)?needs\s+to\s+(.+)$/i);
  if (!match) return null;
  const task = match[2].replace(/[.!]$/, "").trim();
  if (/\bneeds?\s+to\b|(?:,\s*|\band\s+)@|;/i.test(task)) return null;
  const due = task.match(/\s+(?:by|due)\s+(.+)$/i);
  const description = (due ? task.slice(0, due.index) : task).trim();
  if (!description) return null;
  return { assigneeReference: match[1].trim(), description, deadlineText: due?.[1].trim() };
}
