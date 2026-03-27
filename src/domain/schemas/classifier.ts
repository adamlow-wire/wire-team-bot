import { z } from "zod";

const VALID_CATEGORIES = [
  "decision",
  "action",
  "blocker",
  "question",
  "update",
  "discussion",
  "reference",
  "routine",
] as const;

export const ClassifyOutputSchema = z.object({
  categories: z.array(z.enum(VALID_CATEGORIES)).default([]),
  confidence: z.number().min(0).max(1).default(0),
  entities: z.array(z.string()).default([]),
  is_high_signal: z.boolean().default(false),
});

export type ClassifyOutput = z.infer<typeof ClassifyOutputSchema>;
