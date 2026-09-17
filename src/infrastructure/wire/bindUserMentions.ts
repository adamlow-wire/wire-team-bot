import { sameQualifiedId, type QualifiedId } from "../../domain/ids/QualifiedId";

interface Mention {
  userId: QualifiedId;
  offset: number;
  length: number;
}

/** Keep structured identities intact while the command grammar parses surrounding words. */
export function bindUserMentions(text: string, mentions: readonly Mention[], botId: QualifiedId) {
  const people = mentions.filter(m => !sameQualifiedId(m.userId, botId)).sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const m of people) {
    if (!Number.isInteger(m.offset) || !Number.isInteger(m.length) || m.offset < end || m.length < 1
      || m.offset + m.length > text.length || text[m.offset] !== "@") return null;
    end = m.offset + m.length;
  }
  let prefix = "@wire_mention_";
  while (text.includes(prefix)) prefix += "_";
  const bindings = new Map<string, { userId: QualifiedId; label: string }>();
  let bound = text;
  for (let i = people.length - 1; i >= 0; i--) {
    const m = people[i];
    const token = `${prefix}${i}__`;
    bindings.set(token, { userId: m.userId, label: text.slice(m.offset, m.offset + m.length) });
    bound = bound.slice(0, m.offset) + token + bound.slice(m.offset + m.length);
  }
  return {
    text: bound,
    owner: (reference: string | undefined) => reference ? bindings.get(reference) : undefined,
    restore: (value: string) => {
      for (const [token, binding] of bindings) value = value.split(token).join(binding.label);
      return value;
    },
  };
}
