import { z } from "zod/v4";

export const chatReferenceSchema = z.object({
  title: z.string(),
  source: z.string(),
  score: z.number(),
  excerpt: z.string(),
});

export const chatResponseSchema = z.object({
  message: z.string(),
  data: z
    .object({
      answer: z.string(),
      a2ui: z.array(z.unknown()).optional(),
      references: z.array(chatReferenceSchema).optional(),
    })
    .optional(),
});

export const aiOpsResponseSchema = z.object({
  message: z.string(),
  data: z
    .object({
      result: z.string(),
      detail: z.array(z.string()).optional(),
      a2ui: z.array(z.unknown()).optional(),
    })
    .optional(),
});

export const a2uiActionResponseSchema = z.object({
  message: z.string(),
  data: z
    .object({
      a2ui: z.array(z.unknown()).min(1),
    })
    .nullish(),
});

export const uploadResponseSchema = z.object({
  message: z.string(),
  data: z.unknown().optional(),
});
