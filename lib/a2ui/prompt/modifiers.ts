/**
 * Schema modifiers applied to schemas before prompt rendering.
 *
 * Ported from the A2UI Python agent SDK `a2ui/schema/common_modifiers.py` and
 * the modifier application in `DirectJsonFormat._load_schemas`.
 */

import type { A2uiCatalogSchemas, JsonObject, JsonValue } from "./types";
import { isJsonObject } from "./types";

export type SchemaModifier = (schema: JsonValue) => JsonValue;

/**
 * Removes closed-object constraints (`additionalProperties: false` and
 * `unevaluatedProperties: false`), which make LLM output fail validation on
 * harmless extra keys.
 */
export function removeStrictValidation(schema: JsonValue): JsonValue {
  if (isJsonObject(schema)) {
    const newSchema: JsonObject = {};
    for (const [key, value] of Object.entries(schema)) {
      newSchema[key] = removeStrictValidation(value);
    }
    if (newSchema["additionalProperties"] === false) {
      delete newSchema["additionalProperties"];
    }
    if (newSchema["unevaluatedProperties"] === false) {
      delete newSchema["unevaluatedProperties"];
    }
    return newSchema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => removeStrictValidation(item));
  }
  return schema;
}

/** Applies modifiers to all three catalog schemas, like `_load_schemas`. */
export function applySchemaModifiers(
  catalog: A2uiCatalogSchemas,
  modifiers: SchemaModifier[],
): A2uiCatalogSchemas {
  const apply = (schema: JsonObject): JsonObject =>
    modifiers.reduce<JsonValue>(
      (acc, modifier) => modifier(acc),
      schema,
    ) as JsonObject;
  return {
    s2cSchema: apply(catalog.s2cSchema),
    commonTypesSchema: apply(catalog.commonTypesSchema),
    catalogSchema: apply(catalog.catalogSchema),
  };
}
