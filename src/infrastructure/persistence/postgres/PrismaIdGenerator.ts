import { getPrismaClient } from "./PrismaClient";

/**
 * Entity-type prefixes used in human-readable IDs (e.g. TASK-0001).
 */
const PREFIX = {
  task: "TASK",
  decision: "DEC",
  action: "ACT",
  reminder: "REM",
  knowledge: "KB",
} as const;

type EntityType = keyof typeof PREFIX;

/**
 * Atomically generates the next sequential ID for the given entity type.
 *
 * Uses a single INSERT … ON CONFLICT DO UPDATE statement so concurrent callers
 * each receive a distinct value — no race condition possible.
 */
export async function nextEntityId(entityType: EntityType): Promise<string> {
  const prisma = getPrismaClient();
  const rows = await prisma.$queryRaw<Array<{ next_val: number }>>`
    INSERT INTO entity_id_sequences (entity_type, next_val)
    VALUES (${entityType}, 1)
    ON CONFLICT (entity_type) DO UPDATE
      SET next_val = entity_id_sequences.next_val + 1
    RETURNING next_val`;
  const n = Number(rows[0]?.next_val ?? 1);
  return `${PREFIX[entityType]}-${n.toString().padStart(4, "0")}`;
}
