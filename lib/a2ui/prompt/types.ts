/**
 * Shared types for the A2UI system prompt generators.
 *
 * Ported from the A2UI Python agent SDK (`a2ui.prompt.PromptGenerator` and
 * `a2ui.schema.catalog.A2uiCatalog`), aligned with protocol v0.9.
 */

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

/**
 * The three schema documents that make up a processed A2UI catalog, mirroring
 * the Python `A2uiCatalog` (s2c_schema / common_types_schema / catalog_schema).
 */
export interface A2uiCatalogSchemas {
  /** The server-to-client message envelope JSON schema. */
  s2cSchema: JsonObject;
  /** The shared common types JSON schema. */
  commonTypesSchema: JsonObject;
  /** The component/function catalog JSON schema (e.g. catalog.json). */
  catalogSchema: JsonObject;
}

/**
 * Options accepted by every prompt generator, mirroring the parameters of the
 * Python `PromptGenerator.generate(...)` signature.
 */
export interface SystemPromptOptions {
  /** Description of the agent's role. First section of the prompt. */
  roleDescription: string;
  /** Optional description of the task workflow, appended to the format rules. */
  workflowDescription?: string;
  /** Optional UI context or rules, rendered as a "## UI Description:" section. */
  uiDescription?: string;
  /** Optional list of component names the LLM may use (prunes the catalog). */
  allowedComponents?: string[];
  /** Optional list of A2UI message types allowed (prunes the s2c schema). */
  allowedMessages?: string[];
  /** Whether to include the catalog schema/signatures section. Default true. */
  includeSchema?: boolean;
  /**
   * Optional preformatted few-shot examples markdown, rendered as a
   * "### Examples:" section. (The Python SDK loads these from files; here the
   * caller provides the already-formatted text.) Ignored by the Atom format.
   */
  examples?: string;
}

export interface PromptGenerator {
  generate(options: SystemPromptOptions): string;
}
