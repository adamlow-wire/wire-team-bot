/** Fixed command output has an exact contract; a model cannot overrule it. */
export function exactReplyMatches(actual: string, expected: string): boolean {
  return actual.trim() === expected.trim();
}
