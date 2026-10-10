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

export const SHADCN_PROMPT_CATALOG: A2uiCatalogSchemas = {
  s2cSchema: SERVER_TO_CLIENT_SCHEMA,
  commonTypesSchema: COMMON_TYPES_SCHEMA,
  catalogSchema: SHADCN_CATALOG_SCHEMA,
};

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

export function generateSystemPrompt(
  format: A2uiInferenceFormat,
  options: SystemPromptOptions,
  catalog: A2uiCatalogSchemas = SHADCN_PROMPT_CATALOG,
): string {
  return createPromptGenerator(format, catalog).generate(options);
}
