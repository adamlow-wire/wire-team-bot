import { z } from "zod";

export const SeedPersonSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  role: z.string().optional(),
});

export const SeedDecisionSchema = z.object({
  summary: z.string().min(1),
  tags: z.array(z.string()).default([]),
  rationale: z.string().optional(),
});

export const SeedTerminologySchema = z.object({
  term: z.string().min(1),
  definition: z.string().min(1),
});

export const SeedFileSchema = z.object({
  version: z.literal(1),
  organisation: z
    .object({
      name: z.string(),
      description: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
  people: z.array(SeedPersonSchema).default([]),
  decisions: z.array(SeedDecisionSchema).default([]),
  terminology: z.array(SeedTerminologySchema).default([]),
});

export type SeedFile = z.infer<typeof SeedFileSchema>;
