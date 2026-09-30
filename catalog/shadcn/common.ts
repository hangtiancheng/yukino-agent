import { z } from "zod/v3";

import {
  AccessibilityAttributesSchema,
  ActionSchema,
  DynamicStringSchema,
} from "@a2ui/web_core/v0_9";

import { ICON_MAP } from "@/catalog/components/icon";

// Shared props mirroring the basic catalog's CommonProps: every extension
// schema spreads this so agents can use the same common fields everywhere.
// `accessibility` is accepted for catalog parity but intentionally not
// rendered (see AGENTS.md).
export const COMMON = {
  weight: z
    .number()
    .describe("Relative flex weight when placed inside a Row or Column.")
    .optional(),
  accessibility: AccessibilityAttributesSchema.optional(),
};

export const ICON_NAME = z
  .enum(Object.keys(ICON_MAP) as [string, ...string[]])
  .describe("An icon name from the basic catalog icon set.");

export const MENU_ENTRY = z.object({
  label: DynamicStringSchema.describe("The label of the entry."),
  action: ActionSchema.optional(),
  variant: z.enum(["default", "destructive"]).optional(),
  disabled: z.boolean().optional(),
});
