import { z } from "zod";

const clamp01 = z.number().min(0).max(1);

export const ExtractedDecisionSchema = z.object({
  summary: z.string().min(1).max(500),
  rationale: z.string().optional(),
  decided_by: z.array(z.string()).default([]),
  confidence: clamp01.default(0.5),
  tags: z.array(z.string()).default([]),
});

export const ExtractedActionSchema = z.object({
  description: z.string().min(1).max(500),
  owner_name: z.string().optional(),
  deadline_text: z.string().optional(),
  confidence: clamp01.default(0.5),
  tags: z.array(z.string()).default([]),
  supersedes: z.string().optional(),
});

export const ExtractedCompletionSchema = z.object({
  actionId: z.string(),
  note: z.string().optional(),
});

const VALID_ENTITY_TYPES = ["person", "service", "project", "team", "tool", "concept"] as const;
const VALID_RELATIONSHIPS = ["owns", "depends_on", "works_on", "blocks", "reports_to"] as const;
const VALID_SIGNAL_TYPES = ["discussion", "question", "blocker", "update", "concern"] as const;

export const ExtractedEntitySchema = z.object({
  name: z.string().min(1),
  type: z.enum(VALID_ENTITY_TYPES),
  aliases: z.array(z.string()).default([]),
  confidence: clamp01.default(0.5),
});

export const ExtractedRelationshipSchema = z.object({
  source: z.string(),
  target: z.string(),
  relationship: z.enum(VALID_RELATIONSHIPS),
  context: z.string().optional(),
  confidence: clamp01.default(0.5),
});

export const ExtractedSignalSchema = z.object({
  signal_type: z.enum(VALID_SIGNAL_TYPES),
  summary: z.string().min(1),
  confidence: clamp01.default(0.5),
  tags: z.array(z.string()).default([]),
});

export const ExtractionOutputSchema = z.object({
  decisions: z.array(ExtractedDecisionSchema).default([]),
  actions: z.array(ExtractedActionSchema).default([]),
  completions: z.array(ExtractedCompletionSchema).default([]),
  entities: z.array(ExtractedEntitySchema).default([]),
  relationships: z.array(ExtractedRelationshipSchema).default([]),
  signals: z.array(ExtractedSignalSchema).default([]),
});

export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;
