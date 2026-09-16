export function score(records, expected) {
  const used = new Set(); let duplicates = 0;
  const assignments = records.map(record => {
    const candidates = expected.filter(e => e.expected.type === record.type
      && e.expected.terms.every(t => record.content.toLowerCase().includes(t.toLowerCase()))
      && (!e.expected.anyTerms || e.expected.anyTerms.some(t => record.content.toLowerCase().includes(t.toLowerCase())))
      && (!e.expected.owner || record.owner === e.expected.owner));
    // Distinct source events can legitimately contain the same expected fact.
    return candidates.find(e => e.eventId === record.source) ?? candidates[0];
  });
  const groups = new Map();
  assignments.forEach((fact, index) => {
    if (!fact) return;
    const indexes = groups.get(fact.eventId) ?? [];
    indexes.push(index);
    groups.set(fact.eventId, indexes);
  });
  const matches = records.map((record, index) => {
    const fact = assignments[index];
    const indexes = fact ? groups.get(fact.eventId) : [];
    // Prefer the correct source regardless of database row order. Every extra
    // capture of this fact remains an error, including one returned before it.
    const primary = indexes.find(i => records[i].source === fact.eventId) ?? indexes[0];
    const duplicate = indexes.length > 1 && index !== primary;
    const sourceMatches = fact?.eventId === record.source;
    if (duplicate) duplicates++;
    if (fact && sourceMatches && !duplicate) used.add(fact.eventId);
    return { ...record, matchedEvent: sourceMatches ? fact?.eventId ?? null : null, duplicate };
  });
  const correct = used.size;
  return { correct, captured: records.length, expected: expected.length, duplicates,
    precision: expected.length && records.length ? correct / records.length : null, recall: expected.length ? correct / expected.length : null,
    missed: expected.filter(e => !used.has(e.eventId)).map(e => e.eventId), records: matches };
}
