/**
 * A2UI system prompt generators for the shadcn catalog.
 *
 * Ports the four inference-format prompt generators of the A2UI Python agent
 * SDK (Direct JSON, Elemental, Atom, Express) to TypeScript, wired to the
 * shadcn catalog (`packages/shadcn/catalog.json`) and the A2UI v0.9 protocol
 * schemas by default.
 */

import { AtomPromptGenerator } from "./atom";
import { DirectJsonPromptGenerator } from "./direct-json";
import { ElementalPromptGenerator } from "./elemental";
import { ExpressPromptGenerator } from "./express";
import {
  COMMON_TYPES_SCHEMA,
  SERVER_TO_CLIENT_SCHEMA,
  SHADCN_CATALOG_SCHEMA,
} from "./schemas";
import type {
  A2uiCatalogSchemas,
  PromptGenerator,
  SystemPromptOptions,
} from "./types";

export {
  A2UI_CLOSE_TAG,
  A2UI_INFERENCE_CLOSE_TAG,
  A2UI_INFERENCE_OPEN_TAG,
  A2UI_OPEN_TAG,
  A2UI_SCHEMA_BLOCK_END,
  A2UI_SCHEMA_BLOCK_START,
  DEFAULT_WORKFLOW_RULES,
} from "./constants";
export { ATOM_RULES, AtomPromptGenerator } from "./atom";
export {
  DirectJsonPromptGenerator,
  renderAsLlmInstructions,
} from "./direct-json";
export { ELEMENTAL_RULES, ElementalPromptGenerator } from "./elemental";
export { EXPRESS_RULES, ExpressPromptGenerator } from "./express";
export {
  applySchemaModifiers,
  removeStrictValidation,
  type SchemaModifier,
} from "./modifiers";
export { withPruning } from "./pruning";
export { CatalogSchemaHelper } from "./schema-helper";
export {
  COMMON_TYPES_SCHEMA,
  SERVER_TO_CLIENT_SCHEMA,
  SHADCN_CATALOG_SCHEMA,
} from "./schemas";
export type {
  A2uiCatalogSchemas,
  JsonObject,
  JsonValue,
  PromptGenerator,
  SystemPromptOptions,
} from "./types";

/** The shadcn catalog paired with the A2UI v0.9 protocol schemas. */
export const SHADCN_PROMPT_CATALOG: A2uiCatalogSchemas = {
  s2cSchema: SERVER_TO_CLIENT_SCHEMA,
  commonTypesSchema: COMMON_TYPES_SCHEMA,
  catalogSchema: SHADCN_CATALOG_SCHEMA,
};

/** The catalog id of the embedded shadcn catalog. */
export const SHADCN_CATALOG_ID = SHADCN_CATALOG_SCHEMA["catalogId"] as string;

export type A2uiInferenceFormat =
  "direct-json" | "elemental" | "atom" | "express";

export function createPromptGenerator(
  format: A2uiInferenceFormat,
  catalog: A2uiCatalogSchemas = SHADCN_PROMPT_CATALOG,
): PromptGenerator {
  switch (format) {
    case "direct-json":
      return new DirectJsonPromptGenerator(catalog);
    case "elemental":
      return new ElementalPromptGenerator(catalog);
    case "atom":
      return new AtomPromptGenerator(catalog);
    case "express":
      return new ExpressPromptGenerator(catalog);
  }
}

/**
 * Generates a complete system prompt in the requested inference format for
 * the given catalog (the shadcn catalog by default).
 */
export function generateSystemPrompt(
  format: A2uiInferenceFormat,
  options: SystemPromptOptions,
  catalog: A2uiCatalogSchemas = SHADCN_PROMPT_CATALOG,
): string {
  return createPromptGenerator(format, catalog).generate(options);
}
