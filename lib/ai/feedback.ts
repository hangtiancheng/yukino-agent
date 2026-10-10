import { z } from "zod/v4";

export const FEEDBACK_TARGET_TYPES = [
  "chat_message",
  "citation",
  "diagnostic_step",
  "diagnostic_report",
] as const;

export const FEEDBACK_RATINGS = ["positive", "negative"] as const;

export type FeedbackTargetType = (typeof FEEDBACK_TARGET_TYPES)[number];
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

export const SUBJECT_MAX_CHARS = 160;
export const REASON_MAX_CHARS = 80;
export const COMMENT_MAX_CHARS = 2000;
export const CORRECTION_MAX_CHARS = 4000;

function optionalText(max: number) {
  return z
    .string()
    .max(max)
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    });
}

export const FeedbackUpsertSchema = z.object({
  targetType: z.enum(FEEDBACK_TARGET_TYPES),
  targetId: z.string().min(1).max(200),
  subjectId: optionalText(SUBJECT_MAX_CHARS),
  sessionId: z.string().max(200).optional(),
  rating: z.enum(FEEDBACK_RATINGS),
  reason: optionalText(REASON_MAX_CHARS),
  comment: optionalText(COMMENT_MAX_CHARS),
  correction: optionalText(CORRECTION_MAX_CHARS),
});

export type FeedbackUpsertInput = z.infer<typeof FeedbackUpsertSchema>;

export const FeedbackListQuerySchema = z.object({
  targetType: z.enum(FEEDBACK_TARGET_TYPES),
  targetId: z.string().min(1).max(200),
});

export interface FeedbackView {
  id: string;
  sessionId: string;
  targetType: string;
  targetId: string;
  subjectId: string;
  rating: string;
  reason: string | null;
  comment: string | null;
  correction: string | null;
  createdAt: string;
  updatedAt: string;
}
