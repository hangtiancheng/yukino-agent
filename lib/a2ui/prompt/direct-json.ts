/**
 * Direct JSON inference format system prompt generator.
 *
 * Ported from the A2UI Python agent SDK `DirectJsonPromptGenerator`
 * (`a2ui/inference_formats/direct_json/prompt_generator.py`) and
 * `A2uiCatalog.render_as_llm_instructions` (`a2ui/schema/catalog.py`).
 */

import {
  A2UI_SCHEMA_BLOCK_END,
  A2UI_SCHEMA_BLOCK_START,
  DEFAULT_WORKFLOW_RULES,
} from "./constants";
import { withPruning } from "./pruning";
import type {
  A2uiCatalogSchemas,
  JsonValue,
  PromptGenerator,
  SystemPromptOptions,
} from "./types";
import { isJsonObject } from "./types";

/**
 * Matches Python `json.dumps(obj, separators=(",", ":"))` with the default
 * `ensure_ascii=True`, which escapes every code unit >= 0x7f as \uXXXX
 * (astral characters become surrogate-pair escapes, as in Python).
 */
function jsonDumpsCompact(value: JsonValue): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Renders the catalog and schemas as LLM instructions (compact JSON blocks). */
export function renderAsLlmInstructions(catalog: A2uiCatalogSchemas): string {
  const allSchemas: string[] = [A2UI_SCHEMA_BLOCK_START];

  const serverClientStr = catalog.s2cSchema
    ? jsonDumpsCompact(catalog.s2cSchema)
    : "{}";
  allSchemas.push(`### Server To Client Schema:\n${serverClientStr}`);

  const commonDefs = catalog.commonTypesSchema?.["$defs"];
  if (isJsonObject(commonDefs) && Object.keys(commonDefs).length > 0) {
    allSchemas.push(
      `### Common Types Schema:\n${jsonDumpsCompact(catalog.commonTypesSchema)}`,
    );
  }

  allSchemas.push(
    `### Catalog Schema:\n${jsonDumpsCompact(catalog.catalogSchema)}`,
  );

  allSchemas.push(A2UI_SCHEMA_BLOCK_END);

  return allSchemas.join("\n\n");
}

/** Formats standard JSON schema system prompt instructions (Direct JSON format). */
export class DirectJsonPromptGenerator implements PromptGenerator {
  private readonly catalog: A2uiCatalogSchemas;

  constructor(catalog: A2uiCatalogSchemas) {
    this.catalog = catalog;
  }

  generate(options: SystemPromptOptions): string {
    const selectedCatalog = withPruning(
      this.catalog,
      options.allowedComponents,
      options.allowedMessages,
    );

    const parts = [options.roleDescription];

    let rules = DEFAULT_WORKFLOW_RULES;
    if (options.workflowDescription) {
      rules += `\n${options.workflowDescription}`;
    }
    parts.push(`## Workflow Description:\n${rules}`);

    if (options.uiDescription) {
      parts.push(`## UI Description:\n${options.uiDescription}`);
    }

    if (options.includeSchema ?? true) {
      const instructions = renderAsLlmInstructions(selectedCatalog);
      if (instructions) parts.push(instructions);
    }

    if (options.examples) {
      parts.push(`### Examples:\n${options.examples}`);
    }

    return parts.join("\n\n");
  }
}
