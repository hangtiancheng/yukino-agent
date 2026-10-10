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

function jsonDumpsCompact(value: JsonValue): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

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
