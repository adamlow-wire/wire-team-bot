import { z } from "zod";

const VALID_INTENTS = [
  "factual_recall",
  "temporal_context",
  "cross_channel",
  "accountability",
  "institutional",
  "dependency",
] as const;

const VALID_PATHS = ["structured", "semantic", "graph", "summary"] as const;
const VALID_FORMATS = ["direct_answer", "summary", "list", "comparison"] as const;

export const QueryPlanSchema = z.object({
  intent: z.enum(VALID_INTENTS).default("factual_recall"),
  entities: z.array(z.string()).default([]),
  timeRange: z
    .object({
      start: z.string().optional(),
      end: z.string().optional(),
    })
    .nullable()
    .default(null),
  channels: z.array(z.string()).nullable().default(null),
  paths: z
    .array(
      z.object({
        path: z.enum(VALID_PATHS),
        params: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
  responseFormat: z.enum(VALID_FORMATS).default("direct_answer"),
  complexity: z.number().min(0).max(1).default(0.3),
});

export type QueryPlanRaw = z.infer<typeof QueryPlanSchema>;
