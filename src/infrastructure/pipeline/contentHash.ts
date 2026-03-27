import { createHash } from "node:crypto";

/** Normalise: lowercase, trim, collapse interior whitespace. */
export function normaliseText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Returns hex SHA-256 of normalise(text). Deterministic across calls. */
export function computeContentHash(text: string): string {
  return createHash("sha256").update(normaliseText(text)).digest("hex");
}
