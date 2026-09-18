import { sameQualifiedId, type QualifiedId } from "../../domain/ids/QualifiedId";

interface Mention {
  userId: QualifiedId;
  offset: number;
  length: number;
}

// Only recognise explicit command starts. This is a rejection guard, not a batch
// parser: ordinary conjunctions and multiline task descriptions remain intact.
const COMMAND_START = /^(?:(?:decision|action|context):|remind(?:er)?\s|(?:make|set|create|add)\s+(?:a\s+)?reminder\b|(?:ACT-\d+)\s+(?:done|cancelled|in[_\s]progress|close|complete|cancel|reassign|due)\b|(?:done|close|complete|cancel|cancelled|in[_\s]progress)\s+ACT-\d+\b|(?:cancel|snooze)\s+REM-\d+\b|revoke\s+DEC-\d+\b|(?:my|team|overdue)\s+actions?\b|(?:my|show|list)\s+reminders?\b|list\s+decisions?\b|decisions?\s+(?:about|on|for|regarding)\b|search\s+decisions?\b|(?:pause|resume|secure mode|status|catch me up|what did I miss)[?.!`]*\s*$)/i;

export function hasMultipleCommands(text: string, mentions: readonly Mention[], botId: QualifiedId): boolean {
  // Work from original UTF-16 offsets. Mask person labels so a name containing
  // command syntax cannot become a command. Never infer identity from its label.
  const spans = [...mentions].sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const m of spans) {
    if (!Number.isInteger(m.offset) || !Number.isInteger(m.length) || m.offset < end
      || m.length < 1 || m.offset + m.length > text.length) return false;
    end = m.offset + m.length;
  }
  let masked = text;
  for (const m of spans.reverse()) {
    const replacement = sameQualifiedId(m.userId, botId) ? "\n" : "@member";
    masked = masked.slice(0, m.offset) + replacement + masked.slice(m.offset + m.length);
  }
  // Fenced examples are not requests. Keep a placeholder so a prose/example
  // introduction cannot accidentally disappear and expose a command prefix.
  masked = masked.replace(/```[\s\S]*?(?:```|$)/g, "[code example]");
  const parts = masked.split(/\r?\n|;|\s+(?:and\s+then|then|and)\s+/i)
    .map(part => part.trim().replace(/^(?:[-*]\s+|\d+[.)]\s+)/, "")
      .replace(/^@?(?:wire team bot|jeeves)\b(?:\s*\([^)]*\))?\s*[:,]?\s*/i, "")
      .replace(/^`([^`\r\n]+)`(?=\s|$)/, "$1")
      .replace(/^`(?!`)/, "").trim())
    .filter(Boolean);
  return parts.length > 1 && COMMAND_START.test(parts[0])
    && parts.slice(1).some(part => COMMAND_START.test(part));
}
