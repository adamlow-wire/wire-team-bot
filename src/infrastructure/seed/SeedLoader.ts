/**
 * SeedLoader — loads `jeeves-seed.yaml` at startup and upserts the content
 * into the Postgres knowledge store with `source: 'seed'` and `standing: true`.
 *
 * Standing records are immune to contradiction detection and auto-expiry.
 * They persist across restarts; re-seeding is idempotent (upsert by rawMessageId).
 *
 * Schema: see src/domain/schemas/seed.ts
 * Config: JEEVES_SEED_FILE env var → config.app.seedFile
 *
 * Abort policy: if the YAML fails Zod validation, log a fatal error and throw
 * so the startup can surface the misconfiguration immediately.
 */

import fs from "fs";
import yaml from "js-yaml";
import type { Logger } from "../../application/ports/Logger";
import type { DecisionRepository } from "../../domain/repositories/DecisionRepository";
import type { EntityRepository } from "../../domain/repositories/EntityRepository";
import { SeedFileSchema, type SeedFile } from "../../domain/schemas/seed";

const SEED_ORG_ID = "seed";
const SEED_AUTHOR: { id: string; domain: string } = { id: "seed", domain: "seed" };
const SEED_CONVERSATION: { id: string; domain: string } = { id: "global", domain: "seed" };

export class SeedLoader {
  constructor(
    private readonly decisionsRepo: DecisionRepository,
    private readonly entityRepo: EntityRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * Load and upsert the seed file. Throws on schema validation failure.
   * Returns silently if `seedFilePath` is undefined or the file does not exist.
   */
  async load(seedFilePath: string | undefined): Promise<void> {
    if (!seedFilePath) return;

    if (!fs.existsSync(seedFilePath)) {
      this.logger.warn("SeedLoader: seed file not found — skipping", { path: seedFilePath });
      return;
    }

    const raw = fs.readFileSync(seedFilePath, "utf8");
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new Error(`SeedLoader: failed to parse YAML at ${seedFilePath}: ${String(err)}`);
    }

    const result = SeedFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `SeedLoader: seed file schema validation failed:\n${result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`,
      );
    }

    const seed: SeedFile = result.data;
    this.logger.info("SeedLoader: loading seed file", {
      path: seedFilePath,
      decisions: seed.decisions.length,
      people: seed.people.length,
      terminology: seed.terminology.length,
    });

    await this.upsertDecisions(seed);
    await this.upsertPeople(seed);
    await this.upsertTerminology(seed);

    this.logger.info("SeedLoader: seed load complete");
  }

  private async upsertDecisions(seed: SeedFile): Promise<void> {
    const now = new Date();

    for (let i = 0; i < seed.decisions.length; i++) {
      const d = seed.decisions[i]!;
      // Stable synthetic rawMessageId for idempotent upsert
      const rawMessageId = `seed:decision:${i}`;

      // Check if this seed decision already exists
      const existing = await this.decisionsRepo.query({
        conversationId: SEED_CONVERSATION,
      }).then((all) => all.find((dec) => dec.rawMessageId === rawMessageId));

      if (existing) {
        this.logger.debug("SeedLoader: decision already exists — skipping", { rawMessageId });
        continue;
      }

      const id = await this.decisionsRepo.nextId();
      await this.decisionsRepo.create({
        id,
        summary: d.summary,
        rawMessageId,
        context: [],
        authorId: SEED_AUTHOR,
        authorName: "Seed",
        participants: [],
        conversationId: SEED_CONVERSATION,
        status: "active",
        linkedIds: [],
        attachments: [],
        tags: d.tags,
        timestamp: now,
        updatedAt: now,
        deleted: false,
        version: 1,
        rationale: d.rationale,
        decidedBy: [],
        decidedAt: now,
        organisationId: SEED_ORG_ID,
        source: "seed",
        standing: true,
      });

      this.logger.debug("SeedLoader: upserted decision", { id, summary: d.summary.slice(0, 60) });
    }
  }

  private async upsertPeople(seed: SeedFile): Promise<void> {
    for (const person of seed.people) {
      try {
        await this.entityRepo.upsertWithDedup(
          {
            name: person.name,
            entityType: "person",
            aliases: person.aliases,
            metadata: person.role ? { role: person.role } : {},
          },
          SEED_CONVERSATION.id,
          SEED_ORG_ID,
        );
        this.logger.debug("SeedLoader: upserted person", { name: person.name });
      } catch (err) {
        this.logger.warn("SeedLoader: failed to upsert person", { name: person.name, err: String(err) });
      }
    }
  }

  private async upsertTerminology(seed: SeedFile): Promise<void> {
    for (const term of seed.terminology) {
      try {
        await this.entityRepo.upsertWithDedup(
          {
            name: term.term,
            entityType: "concept",
            aliases: [],
            metadata: { definition: term.definition },
          },
          SEED_CONVERSATION.id,
          SEED_ORG_ID,
        );
        this.logger.debug("SeedLoader: upserted term", { term: term.term });
      } catch (err) {
        this.logger.warn("SeedLoader: failed to upsert term", { term: term.term, err: String(err) });
      }
    }
  }
}
