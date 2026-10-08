/**
 * A2UI Express inference format system prompt generator.
 *
 * Ported from the A2UI Python agent SDK `ExpressPromptGenerator`
 * (`a2ui/inference_formats/experimental/express/prompt_generator.py`).
 * Compiles catalog schemas into compact positional plain-text signatures.
 * (Few-shot example decompilation to Express DSL is not ported; provide
 * examples already formatted as Express DSL.)
 */

import { withPruning } from "./pruning";
import { CatalogSchemaHelper, findSchemaEnum } from "./schema-helper";
import type {
  A2uiCatalogSchemas,
  JsonObject,
  JsonValue,
  PromptGenerator,
  SystemPromptOptions,
} from "./types";
import { isJsonObject } from "./types";

export const EXPRESS_RULES = `# A2UI Express DSL Output Contract

You must output the user interface using A2UI Express.

IMPORTANT: You MUST always surround the entire A2UI Express block with the sentinel tags \`<a2ui>\` and \`</a2ui>\`.

The host compiler will compile your A2UI Express output into the correct JSON envelopes automatically.

## Grammar Rules

1. Component constructors can be assigned to variables or nested inline inside parent component arguments:
   header = ComponentA(prop1="val1")
   root = ComponentB([header, ComponentC("Click", action=Event("submit"))])

   Keyword arguments (\`param=value\`) and positional arguments with \`_\` placeholders are supported.

   Variable names MUST start with a letter or underscore, and only contain letters, digits, and underscores.

2. The interface tree must have a single entry point assigned to the reserved variable 'root'.

3. Primitives:
   - Strings: Quoted with \`"\` or \`"""\`. Support for \`\\n\`, \`\\t\`, \`\\\\\`, and \`\\"\` escapes.
     Raw Strings: Prefaced by \`r\` (e.g., \`r"..."\` or \`r"""..."""\`), with no escape processing.
   - Numbers: write as integers or decimals, e.g., 42
   - Booleans: write true or false
   - Null values: write null
   - Dates & Times: Values for date-time inputs (e.g. in DateTimeInput) must strictly use RFC 3339 format with a timezone offset (e.g. "2026-03-14T00:00:00Z").

4. Lists: represent as arrays, e.g., [child1, child2].

5. Maps: represent as key-value blocks, e.g., {title: "Overview", child: contentCol}. Map keys are always literal strings (dynamic variable resolution is not supported for keys).

6. Data bindings: prefix absolute paths in the data model with '$', e.g., $/user/firstName.
   Prefix relative list scopes with '$', e.g., $firstName.
   A lone '$' represents an empty relative path which resolves to the root of the current context (e.g. inside a template, representing the entire item itself).

7. Logic and validation: prefix client check rules with '?', e.g., ?required or ?regex("^[0-9]{5}$"). To specify a custom error message for validation failures, append it as an extra string argument, e.g. ?regex("^[0-9]{5}$", "Postal code must be 5 digits").

8. Action events: represent server-side actions using the Event helper:
   Event("save_deal", {rep: $/form/rep})

9. Nested functions: call client functions directly using catalog signatures, for example myFunction("value").

10. Data model population: Assign a value directly to an absolute data path (e.g. $/path/to/key = "value") to populate or initialize values inside the shared dataModel. The value can be a primitive, array, or map.

11. Dynamic list templates: If a component expects a template child list, represent it using the _template helper:
    _template($/path/to/list, itemTemplate)
    And define the template component variable on another line, utilizing relative path references prefixed with $:
    itemTemplate = Image($url)

12. To delete a user interface surface, output the standalone \`deleteSurface(surfaceId)\` command (no variable assignment):
    deleteSurface("dashboard-surface-1")

13. Static properties: Arguments annotated with '(static)' in the signatures below MUST be defined as literal values or arrays inline. You CANNOT use a dynamic data binding path (prefixed by $) for these arguments.

14. Required actions: Parameters named 'action' (or annotated in component signatures) are strictly required. You must pass a valid Event (e.g. Event("click")) or function call. If no specific action is described in the user request, you must provide a dummy click event like Event("click") instead of passing null or omitting the parameter.

15. Surface targeting: Output \`surface(surfaceId)\` to specify or target a user interface surface:
    surface("dashboard-surface-1")
    root = Card(...)`;

/** Checks if a JSON schema allows data binding (DynamicString/DataBinding, etc). */
function schemaAllowsDatabinding(
  propSchema: JsonValue | null | undefined,
): boolean {
  if (!isJsonObject(propSchema)) return false;
  const ref = propSchema["$ref"];
  if (typeof ref === "string") {
    if (
      ref.includes("DataBinding") ||
      ref.includes("Dynamic") ||
      ref.includes("ChildList")
    ) {
      return true;
    }
  }
  const subs = [
    ...(Array.isArray(propSchema["oneOf"]) ? propSchema["oneOf"] : []),
    ...(Array.isArray(propSchema["anyOf"]) ? propSchema["anyOf"] : []),
    ...(Array.isArray(propSchema["allOf"]) ? propSchema["allOf"] : []),
  ];
  return subs.some((sub) => schemaAllowsDatabinding(sub));
}

function subKeyLines(properties: JsonObject): string[] {
  return Object.entries(properties).map(([subKey, subValue]) => {
    const desc =
      isJsonObject(subValue) && typeof subValue["description"] === "string"
        ? subValue["description"]
        : "";
    return `    * ${subKey}${desc ? ` - ${desc}` : ""}`;
  });
}

/**
 * Generates system prompt contracts guiding models to produce A2UI Express.
 */
export class ExpressPromptGenerator implements PromptGenerator {
  private readonly catalog: A2uiCatalogSchemas;
  private helper: CatalogSchemaHelper;

  constructor(catalog: A2uiCatalogSchemas) {
    this.catalog = catalog;
    this.helper = new CatalogSchemaHelper(catalog.catalogSchema);
  }

  /** Compiles component definitions into clean function-like signatures. */
  generateComponentSignatures(): string {
    const signatures: string[] = [];
    for (const name of Object.keys(this.helper.componentProperties).sort()) {
      const props = this.helper.getComponentProperties(name);
      const reqs = this.helper.getComponentRequired(name);
      const compDesc = this.helper.getComponentDescription(name);

      const orderedArgs: string[] = [];
      const propDetails: string[] = [];
      for (const p of props) {
        const optSuffix = reqs.includes(p) ? "" : "?";
        const propSchema = this.helper.getPropertySchema(name, p);

        let argLabel = `${p}${optSuffix}`;

        const ref = propSchema?.["$ref"];
        const isComponentId =
          typeof ref === "string" && ref.includes("ComponentId");

        if (isComponentId) {
          argLabel += " (component ID)";
        } else if (!schemaAllowsDatabinding(propSchema)) {
          argLabel += " (static)";
        }

        orderedArgs.push(argLabel);

        const propDesc =
          propSchema && typeof propSchema["description"] === "string"
            ? propSchema["description"]
            : null;
        const enumVals = findSchemaEnum(propSchema ?? undefined);

        if (propDesc || enumVals) {
          const lineParts: string[] = [];
          if (propDesc) lineParts.push(propDesc);
          if (enumVals) {
            const enumValsStr = enumVals
              .map((v) => `'${String(v)}'`)
              .join(", ");
            lineParts.push(`Must be one of: ${enumValsStr}`);
          }
          propDetails.push(`  - ${p}: ${lineParts.join(" ")}`);
        }

        // Describe nested object structures (maps and lists of maps).
        if (propSchema) {
          if (
            propSchema["type"] === "object" &&
            isJsonObject(propSchema["properties"])
          ) {
            const subKeys = subKeyLines(propSchema["properties"]);
            const last = propDetails[propDetails.length - 1];
            if (last !== undefined && last.startsWith(`  - ${p}:`)) {
              propDetails[propDetails.length - 1] =
                `${last}\n    Map keys:\n${subKeys.join("\n")}`;
            } else {
              propDetails.push(
                `  - ${p}: Map with keys:\n${subKeys.join("\n")}`,
              );
            }
          } else if (
            propSchema["type"] === "array" &&
            propSchema["items"] !== undefined
          ) {
            const itemsSchema = propSchema["items"];
            if (
              isJsonObject(itemsSchema) &&
              itemsSchema["type"] === "object" &&
              isJsonObject(itemsSchema["properties"])
            ) {
              const subKeys = subKeyLines(itemsSchema["properties"]);
              const last = propDetails[propDetails.length - 1];
              if (last !== undefined && last.startsWith(`  - ${p}:`)) {
                propDetails[propDetails.length - 1] =
                  `${last}\n    List of maps keys:\n${subKeys.join("\n")}`;
              } else {
                propDetails.push(
                  `  - ${p}: List of maps with keys:\n${subKeys.join("\n")}`,
                );
              }
            }
          }
        }
      }

      let sig = `• ${name}(${orderedArgs.join(", ")})`;
      if (compDesc) {
        const descIndented = compDesc.replaceAll("\n", "\n    ");
        sig += `\n  - Description: ${descIndented}`;
      }
      if (propDetails.length > 0) {
        sig += `\n${propDetails.join("\n")}`;
      }
      signatures.push(sig);
    }
    return signatures.join("\n");
  }

  /** Compiles function definitions into clean signatures. */
  generateFunctionSignatures(): string {
    const signatures: string[] = [];
    for (const name of Object.keys(this.helper.functionProperties).sort()) {
      const props = this.helper.getFunctionProperties(name);
      const reqs = this.helper.getFunctionRequired(name);
      const funcDesc = this.helper.getFunctionDescription(name);

      const orderedArgs: string[] = [];
      const propDetails: string[] = [];

      const funcSchema: JsonObject = this.helper.functions[name] ?? {};
      const properties = isJsonObject(funcSchema["properties"])
        ? funcSchema["properties"]
        : {};
      const argsObj = isJsonObject(properties["args"])
        ? properties["args"]
        : {};
      const argsProperties = isJsonObject(argsObj["properties"])
        ? argsObj["properties"]
        : {};

      for (const p of props) {
        const optSuffix = reqs.includes(p) ? "" : "?";
        orderedArgs.push(`${p}${optSuffix}`);

        const propSchema = argsProperties[p];
        const propDesc =
          isJsonObject(propSchema) &&
          typeof propSchema["description"] === "string"
            ? propSchema["description"]
            : null;
        if (propDesc) {
          propDetails.push(`  - ${p}: ${propDesc}`);
        }
      }

      let sig = `• ${name}(${orderedArgs.join(", ")})`;
      if (funcDesc) {
        const descIndented = funcDesc.replaceAll("\n", "\n    ");
        sig += `\n  - Description: ${descIndented}`;
      }
      if (propDetails.length > 0) {
        sig += `\n${propDetails.join("\n")}`;
      }
      signatures.push(sig);
    }
    return signatures.join("\n");
  }

  /** Assembles the system prompt component catalog signatures block. */
  catalogDescription(includeSchema = true): string {
    if (!includeSchema) return "";

    const compSigs = this.generateComponentSignatures();
    const funcSigs = this.generateFunctionSignatures();
    const catalogInstructions =
      typeof this.helper.catalog["instructions"] === "string"
        ? this.helper.catalog["instructions"]
        : "";

    const catalogInstructionsBlock = catalogInstructions
      ? `\n\n## Catalog Instructions\n\n${catalogInstructions}`
      : "";

    return (
      "## Positional Component Signatures\n\nUse these exact positional" +
      " signatures to instantiate components. Do not output property" +
      ` keys:\n${compSigs}\n\n## Positional Function Signatures\n\nUse these` +
      " exact positional signatures to instantiate check rules or logic" +
      ` functions:\n${funcSigs}${catalogInstructionsBlock}`
    );
  }

  generate(options: SystemPromptOptions): string {
    // Mirror the Python implementation: pruning starts from the original
    // catalog on every call and is never written back.
    let catalog = this.catalog;
    if (options.allowedComponents?.length || options.allowedMessages?.length) {
      catalog = withPruning(
        catalog,
        options.allowedComponents,
        options.allowedMessages,
      );
    }
    this.helper = new CatalogSchemaHelper(catalog.catalogSchema);

    const parts = [options.roleDescription];

    let rules = EXPRESS_RULES;
    if (options.workflowDescription) {
      rules += `\n\n${options.workflowDescription}`;
    }
    parts.push(`## Workflow Description:\n${rules}`);

    if (options.uiDescription) {
      parts.push(`## UI Description:\n${options.uiDescription}`);
    }

    if (options.includeSchema ?? true) {
      parts.push(this.catalogDescription(true));
    }

    if (options.examples) {
      parts.push(`### Examples:\n${options.examples}`);
    }

    return parts.join("\n\n");
  }
}
