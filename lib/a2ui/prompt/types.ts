export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface JsonObject {
  [key: string]: JsonValue;
}

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface A2uiCatalogSchemas {
  s2cSchema: JsonObject;
  commonTypesSchema: JsonObject;
  catalogSchema: JsonObject;
}

export interface SystemPromptOptions {
  roleDescription: string;
  workflowDescription?: string;
  uiDescription?: string;
  allowedComponents?: string[];
  allowedMessages?: string[];
  includeSchema?: boolean;
  examples?: string;
}

export interface PromptGenerator {
  generate(options: SystemPromptOptions): string;
}
