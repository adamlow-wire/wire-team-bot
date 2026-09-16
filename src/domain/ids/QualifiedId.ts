export interface QualifiedId {
  id: string;
  domain: string;
}


/** Compare both halves of a federated identity. */
export function sameQualifiedId(a: QualifiedId, b: QualifiedId): boolean {
  return a.id === b.id && a.domain === b.domain;
}
