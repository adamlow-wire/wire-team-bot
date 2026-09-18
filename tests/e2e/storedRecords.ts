/** Synthetic post-drain facts; generated record IDs are deliberately not matching keys. */
export interface StoredRecord {
  type: "decision" | "action" | "reminder";
  source: string;
  content: string;
  author?: string;
  owner?: string;
  decidedBy?: string[];
  deadline?: string | null;
  status: string;
}

export interface ExpectedRecord {
  type: StoredRecord["type"];
  sourceStep: number;
  terms: string[];
  author?: string;
  owner?: string;
  decidedBy?: string[];
  deadline?: string | null;
  status?: string;
}

export function checkStoredRecords(records: StoredRecord[], expected: ExpectedRecord[], sourceIds: string[]): string[] {
  const failures: string[] = [];
  const used = new Set<number>();
  for (const fact of expected) {
    const source = sourceIds[fact.sourceStep - 1];
    const index = records.findIndex((record, i) => !used.has(i) && record.type === fact.type
      && source !== undefined && record.source === source
      && fact.terms.every(term => record.content.toLowerCase().includes(term.toLowerCase()))
      && (fact.author === undefined || record.author === fact.author)
      && (fact.owner === undefined || record.owner === fact.owner)
      && (fact.deadline === undefined || record.deadline === fact.deadline)
      && (fact.status === undefined || record.status === fact.status)
      && (fact.decidedBy === undefined || JSON.stringify([...(record.decidedBy ?? [])].sort()) === JSON.stringify([...fact.decidedBy].sort())));
    if (index < 0) failures.push(`Missing or incorrect stored fact: ${JSON.stringify({ ...fact, source })}`);
    else used.add(index);
  }
  for (const [index, record] of records.entries()) {
    if (!used.has(index)) failures.push(`Unexpected, duplicate or incorrect stored record: ${JSON.stringify(record)}`);
  }
  return failures;
}
