/**
 * Tier 2 Extractor — uses the `extract` model slot (larger, higher-quality model).
 * Receives the sliding window for context. Extracts decisions, actions, entities,
 * relationships, and signals from the conversation. NEVER stores verbatim content.
 *
 * On failure: logs error and returns empty result.
 * Uses Vercel AI SDK generateObject() with Zod schema — no manual JSON parsing.
 */

import { generateObject } from "ai";
import type {
  ExtractionPort,
  ExtractResult,
  ExtractedDecision,
  ExtractedAction,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractedSignal,
  ExtractedCompletion,
  KnownAction,
} from "../../application/ports/ExtractionPort";
import type { ChannelContext } from "../../application/ports/ClassifierPort";
import type { WindowMessage } from "../buffer/SlidingWindowBuffer";
import type { VercelAISlotFactory } from "./VercelAISlotFactory";
import type { Logger } from "../../application/ports/Logger";
import { ExtractionOutputSchema } from "../../domain/schemas/extraction";

function buildSystemPrompt(botName: string): string {
  return `You are the Tier 2 knowledge extractor for ${botName}, a discreet team assistant.

Extract structured knowledge from the TRIGGERING MESSAGE ONLY. Use the conversation window purely as context to resolve ambiguous references (pronouns, "it", "that", "this", unnamed actors) — do not extract new facts from window messages as those have already been processed.

Window messages annotated with "→ extracted:" show what ${botName} already recorded from that message. Use these annotations to understand what is already known — do not re-extract the same information.

CRITICAL: Never include verbatim quotes. Synthesise and summarise only. The source text is discarded after extraction.

── COMPLETIONS ──────────────────────────────────────────────────────────────
If the triggering message announces that a Known open action has been completed (past tense: "I've sent", "we signed", "it's done", "all sorted"), do NOT create a new action. Instead add an entry to "completions" referencing the action ID. Completion language is not a new commitment.

── SUPERSEDES ───────────────────────────────────────────────────────────────
If the triggering message is a personal commitment ("I'll handle it", "I will do that") and the same task already exists in Known open actions (unassigned or under a different owner), set "supersedes" to that action's ID. The pipeline will close the old one and create the new owned version.

Extract from the triggering message:
- decisions: firm conclusions or choices made ("we agreed to...", "we're going with...", "decided that...") — not hypotheticals or questions
- actions: clear commitments with an owner ("Alice will...", "Bob to...", "I'll handle it") — not vague intentions
- completions: announcements that a Known open action is finished (see above)
- entities: named things (person, service, project, team, tool, concept)
- relationships: typed edges between entities
- signals: lightweight notes about the conversation (discussion | question | blocker | update | concern)

Valid entity types: person, service, project, team, tool, concept
Valid relationship types: owns, depends_on, works_on, blocks, reports_to
Valid signal types: discussion, question, blocker, update, concern

If nothing to extract in a category, return an empty array.`;
}

const EMPTY_RESULT: ExtractResult = {
  decisions: [],
  actions: [],
  completions: [],
  entities: [],
  relationships: [],
  signals: [],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sanitiseOwner = (name: string | undefined) =>
  name && !UUID_RE.test(name) ? name : "unassigned";

export class OpenAIExtractionAdapter implements ExtractionPort {
  constructor(
    private readonly llm: VercelAISlotFactory,
    private readonly logger: Logger,
    private readonly botName: string = "Jeeves",
  ) {}

  async extract(
    currentMessage: WindowMessage,
    window: WindowMessage[],
    context: ChannelContext,
    knownEntities: string[],
    knownActions: KnownAction[],
  ): Promise<ExtractResult> {
    const purposeLine = context.purpose ? `Channel purpose: ${context.purpose}\n` : "";
    const contextTypeLine = context.contextType ? `Channel type: ${context.contextType}\n` : "";
    const knownLine =
      knownEntities.length > 0
        ? `Known entities in channel (do not re-extract unless information changes): ${knownEntities.slice(0, 30).join(", ")}\n`
        : "";

    // Build annotation map: messageId → extracted action summary
    const msgAnnotations = new Map<string, string>();
    for (const a of knownActions) {
      if (a.rawMessageId) {
        const existing = msgAnnotations.get(a.rawMessageId);
        const entry = `${a.id}: ${a.description} (owner: ${sanitiseOwner(a.assigneeName)}, open)`;
        msgAnnotations.set(a.rawMessageId, existing ? `${existing}; ${entry}` : entry);
      }
    }

    const knownActionsLine =
      knownActions.length > 0
        ? `Known open actions (do not re-extract; use action IDs for supersedes/completions):\n${knownActions
            .slice(0, 10)
            .map((a) => `  ${a.id}: ${a.description} (owner: ${sanitiseOwner(a.assigneeName)})`)
            .join("\n")}\n`
        : "";

    // Never expose raw UUIDs as speaker labels
    const windowText = window
      .map((m) => {
        const label = m.authorName || "unknown";
        const annotation = msgAnnotations.get(m.messageId);
        const suffix = annotation ? `  → extracted: ${annotation}` : "";
        return `[${label}] ${m.text}${suffix}`;
      })
      .join("\n");

    const senderLabel = currentMessage.authorName || "unknown";
    const currentLine = `[${senderLabel}] ${currentMessage.text}`;

    const prompt = [
      purposeLine + contextTypeLine + knownLine + knownActionsLine,
      "Conversation window (oldest first):",
      windowText || "(none)",
      "",
      `Triggering message: ${currentLine}`,
    ].join("\n");

    try {
      const { object, usage } = await generateObject({
        model: this.llm.getModel("extract"),
        schema: ExtractionOutputSchema,
        system: buildSystemPrompt(this.botName),
        prompt,
        maxRetries: 2,
      });

      this.logger.info("Pipeline: Tier 2 extract", {
        channelId: context.channelId,
        decisions: object.decisions.length,
        actions: object.actions.length,
        completions: object.completions.length,
        entities: object.entities.length,
        relationships: object.relationships.length,
        signals: object.signals.length,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        slot: "extract",
      });

      const knownIds = new Set(knownActions.map((a) => a.id));

      const decisions: ExtractedDecision[] = object.decisions.map((d) => ({
        summary: d.summary,
        rationale: d.rationale,
        decidedBy: d.decided_by,
        confidence: d.confidence,
        tags: d.tags,
      }));

      const actions: ExtractedAction[] = object.actions.map((a) => ({
        description: a.description,
        ownerName: a.owner_name,
        deadline: a.deadline_text,
        confidence: a.confidence,
        tags: a.tags,
        supersedes: a.supersedes,
      }));

      // Only accept completions that reference known action IDs to prevent hallucinations
      const completions: ExtractedCompletion[] = object.completions
        .filter((c) => knownIds.has(c.actionId))
        .map((c) => ({ actionId: c.actionId, note: c.note }));

      const entities: ExtractedEntity[] = object.entities.map((e) => ({
        name: e.name,
        entityType: e.type,
        aliases: e.aliases,
        metadata: {},
      }));

      const relationships: ExtractedRelationship[] = object.relationships.map((r) => ({
        sourceName: r.source,
        targetName: r.target,
        relationship: r.relationship,
        context: r.context,
        confidence: r.confidence,
      }));

      const signals: ExtractedSignal[] = object.signals.map((s) => ({
        signalType: s.signal_type,
        summary: s.summary,
        tags: s.tags,
        confidence: s.confidence,
      }));

      return { decisions, actions, completions, entities, relationships, signals };
    } catch (err) {
      this.logger.error("Extractor LLM call failed — writing fallback signal", {
        channelId: context.channelId,
        err: String(err),
      });
      return EMPTY_RESULT;
    }
  }
}
