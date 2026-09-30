import { z } from "zod/v4";

// Unified API response shape { message, data }, used by the client hook to
// parse fetch responses with zod instead of type assertions. Mirrors the
// shapes returned by the route handlers in app/api/*.

export const chatResponseSchema = z.object({
  message: z.string(),
  data: z
    .object({
      answer: z.string(),
      // A2UI protocol messages are validated per-message by the web_core
      // schema at render time, so they stay unknown[] at this boundary.
      a2ui: z.array(z.unknown()).optional(),
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
  // nullish: error responses carry data: null and should still parse so the
  // real error message can be surfaced.
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
