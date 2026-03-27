import { z } from "zod";

const VALID_SENTIMENTS = ["productive", "contentious", "blocked", "routine"] as const;

export const SummaryOutputSchema = z.object({
  summary: z.string().min(1),
  keyDecisions: z.array(z.string()).default([]),
  keyActions: z.array(z.string()).default([]),
  activeTopics: z.array(z.string()).default([]),
  participants: z.array(z.string()).default([]),
  sentiment: z.enum(VALID_SENTIMENTS).default("routine"),
  messageCount: z.number().int().min(0).default(0),
});

export type SummaryOutput = z.infer<typeof SummaryOutputSchema>;
