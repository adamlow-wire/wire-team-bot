export function score(records, expected) {
  const used = new Set(); let correct = 0; let duplicates = 0;
  const matches = records.map(record => {
    const fact = expected.find(e => e.expected.type === record.type
      && e.expected.terms.every(t => record.content.toLowerCase().includes(t.toLowerCase()))
      && (!e.expected.anyTerms || e.expected.anyTerms.some(t => record.content.toLowerCase().includes(t.toLowerCase())))
      && (!e.expected.owner || record.owner === e.expected.owner));
    const duplicate = !!fact && used.has(fact.eventId);
    const sourceMatches = fact?.eventId === record.source;
    if (duplicate) duplicates++;
    if (fact && sourceMatches && !duplicate) { correct++; used.add(fact.eventId); }
    return { ...record, matchedEvent: sourceMatches ? fact?.eventId ?? null : null, duplicate };
  });
  return { correct, captured: records.length, expected: expected.length, duplicates,
    precision: expected.length && records.length ? correct / records.length : null, recall: expected.length ? correct / expected.length : null,
    missed: expected.filter(e => !used.has(e.eventId)).map(e => e.eventId), records: matches };
}
