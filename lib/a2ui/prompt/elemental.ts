/**
 * A2UI Elemental inference format system prompt generator.
 *
 * Ported from the A2UI Python agent SDK `ElementalPromptGenerator`
 * (`a2ui/inference_formats/experimental/elemental/prompt_generator.py`).
 * Translates catalog JSON schemas into TypeScript interface declarations and
 * instruction blocks. (Few-shot example decompilation to Elemental HTML is not
 * ported; provide examples already formatted for Elemental.)
 */

import { withPruning } from "./pruning";
import { CatalogSchemaHelper } from "./schema-helper";
import type {
  A2uiCatalogSchemas,
  JsonObject,
  JsonValue,
  PromptGenerator,
  SystemPromptOptions,
} from "./types";
import { isJsonObject } from "./types";

export const ELEMENTAL_RULES = `# A2UI Elemental Output Contract

You must output the user interface using A2UI Elemental HTML5-like markup.
You MUST surround the entire block with the sentinel tags \`<a2ui>\` and \`</a2ui>\`.
Inside the sentinel tags, surround the UI layout with \`<body>\` and \`</body>\` tags, including a \`<link rel="catalog" href="[CATALOG_ID]">\` at the start.

## HTML5 Markup Rules

1. Prefix component tags with \`ui-\` in kebab-case (e.g., \`<ui-text-field />\`).
2. Provide a unique \`id\` attribute for every component. The top-level root element must have \`id="root"\`.
3. Wrap numbers, booleans, and expressions in double-quoted curly braces (e.g., \`value="{4}"\`, \`checked="{true}"\`, \`value="{$/path}"\`). Pass static strings as regular attributes without curly braces.
4. Bind data paths using \`{$/path}\` (absolute) or \`{$name}\` (relative in list templates). Use \`{$/items/0}\` for arrays (never brackets).
5. For static options, schemas, or configurations, write literal JSON inside slot script tags instead of binding to a data path: \`<script type="application/json" slot="options">[...]</script>\`.
6. Call functions inside curly braces using named arguments: \`text="{myFunction(arg1: $/myPath, arg2: 'literal')}"\`. Do NOT mix positional and named arguments in any call (e.g., use either all positional arguments like \`{Event('click', {arg: $/path})}\` or all named arguments).
7. Nest child components directly inside parent tags. Do NOT pass layout properties (like \`children\` or \`child\`) as attributes. For named slots (properties expecting a single component, like a leading, trailing, or child element), add the slot attribute to the child: \`<ui-icon slot="leading" />\`.
8. For dynamic lists, specify the data array path on the \`path\` attribute and nest the repeated layout inside a \`<template>\` tag: \`<ui-list path="{$/items}"><template>...</template></ui-list>\`. Do NOT define or duplicate the template's child components anywhere else in the document.
9. Declare component actions using \`on-<event>\` attributes with inline expressions: \`on-click="{Event('click_event')}"\` or \`on-click="{openUrl(url: '...')}"\`. Do not use \`action\` properties.
10. Do not use values starting with \`{\` and ending with \`}\` (like JSON object literals) directly as attribute string values (e.g. \`placeholder="{ 'key': 'val' }"\`), as the compiler will treat it as an expression. Prefix or write without matching outer braces (e.g., \`placeholder="JSON: { 'key': 'val' }"\`).
11. Standalone directives:
    - Data Initialization: \`<script type="application/json">{"data"}</script>\` at the root of the body.
    - Surface Deletion: \`<ui-delete-surface surface-id="id" />\`.
    - Standalone Function Call: \`<ui-call-function id="id" name="func"><script type="application/json" slot="args">{"args"}</script></ui-call-function>\`.
`;

const COMMON_TYPES_DECLARATIONS = `type DataBinding = string;
type A2UIElement = string; // ID of the referenced component
type Action = string; // An inline Event(...) call or catalog function call expression, e.g. "{Event('click', {arg: $/path})}" or "{openUrl(url: '...')}"
type FunctionCall = string; // A catalog function call expression, e.g. "{formatString('Title: \${/path}')}" or "{regex(pattern: '^[A-Z]')}" `;

const DESCRIPTION_TEMPLATE = `## Component Interfaces

Your elements and attributes must match these TypeScript definitions (converting camelCase props to kebab-case attributes in HTML, e.g. \`errorMessage\` -> \`error-message\`).

\`\`\`typescript
[COMMON_TYPES]

[COMPONENT_DECLARATIONS]
\`\`\`

## Helper Functions

You can call these functions inside attribute expressions \`{...}\` using named arguments.

\`\`\`typescript
[FUNCTION_DECLARATIONS]
\`\`\`[CATALOG_INSTRUCTIONS_BLOCK]`;

/** Checks whether a JSON schema allows data binding. */
function schemaAllowsDatabinding(propSchema: JsonValue | undefined): boolean {
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
  if (
    propSchema["type"] === "object" &&
    isJsonObject(propSchema["properties"]) &&
    "path" in propSchema["properties"]
  ) {
    return true;
  }
  const subs = [
    ...(Array.isArray(propSchema["oneOf"]) ? propSchema["oneOf"] : []),
    ...(Array.isArray(propSchema["anyOf"]) ? propSchema["anyOf"] : []),
    ...(Array.isArray(propSchema["allOf"]) ? propSchema["allOf"] : []),
  ];
  return subs.some((sub) => schemaAllowsDatabinding(sub));
}

/** Checks whether a JSON schema represents an Action. */
function isAction(propSchema: JsonValue | null | undefined): boolean {
  if (!isJsonObject(propSchema)) return false;
  const ref = propSchema["$ref"];
  if (typeof ref === "string") return ref.includes("Action");
  const subs = [
    ...(Array.isArray(propSchema["oneOf"]) ? propSchema["oneOf"] : []),
    ...(Array.isArray(propSchema["anyOf"]) ? propSchema["anyOf"] : []),
    ...(Array.isArray(propSchema["allOf"]) ? propSchema["allOf"] : []),
  ];
  if (subs.length > 0) return subs.some((sub) => isAction(sub));
  return false;
}

/** Converts a CamelCase string to kebab-case. */
function toKebabCase(name: string): string {
  return name.replace(/(?<!^)(?=[A-Z])/g, "-").toLowerCase();
}

/**
 * Generates system prompt contracts guiding models to produce A2UI Elemental.
 */
export class ElementalPromptGenerator implements PromptGenerator {
  private catalog: A2uiCatalogSchemas;
  private helper: CatalogSchemaHelper;
  private catalogId: string;

  constructor(catalog: A2uiCatalogSchemas) {
    this.catalog = catalog;
    this.helper = new CatalogSchemaHelper(catalog.catalogSchema);
    this.catalogId =
      typeof catalog.catalogSchema["catalogId"] === "string"
        ? catalog.catalogSchema["catalogId"]
        : "";
  }

  private mapSchemaToTsType(
    componentName: string,
    propName: string,
    propSchema: JsonValue | null | undefined,
  ): string {
    if (propName === "checks") return "FunctionCall[]";

    if (!isJsonObject(propSchema)) return "any";

    const allowsDb = schemaAllowsDatabinding(propSchema);
    let baseType = "any";

    const ref = propSchema["$ref"];
    if (typeof ref === "string") {
      if (ref.includes("ComponentId")) {
        baseType = "A2UIElement";
      } else if (ref.includes("ChildList")) {
        baseType = "A2UIElement[]";
      } else if (ref.includes("Action")) {
        baseType = "Action";
      } else {
        const refName = ref.split("/").pop() ?? "";
        if (refName === "DynamicString" || refName === "String") {
          baseType = "string";
        } else if (
          refName === "DynamicNumber" ||
          refName === "Number" ||
          refName === "Integer"
        ) {
          baseType = "number";
        } else if (refName === "DynamicBoolean" || refName === "Boolean") {
          baseType = "boolean";
        } else if (refName === "DynamicStringList") {
          baseType = "string[]";
        } else {
          baseType = "any";
        }
      }
    } else if (
      propSchema["type"] === "object" &&
      isJsonObject(propSchema["properties"]) &&
      "path" in propSchema["properties"]
    ) {
      // Direct mapping of DataBinding object to TS type.
      baseType = "DataBinding";
    } else if (
      Array.isArray(propSchema["oneOf"]) ||
      Array.isArray(propSchema["anyOf"])
    ) {
      const subs = [
        ...(Array.isArray(propSchema["oneOf"]) ? propSchema["oneOf"] : []),
        ...(Array.isArray(propSchema["anyOf"]) ? propSchema["anyOf"] : []),
      ];
      let types: string[] = [];
      for (const sub of subs) {
        const t = this.mapSchemaToTsType(componentName, propName, sub);
        if (t !== "any") types.push(t);
      }
      if (types.length > 0) {
        types = [...new Set(types)];
        // If we have both 'DataBinding' and some object representation of it,
        // we keep only 'DataBinding'.
        if (types.includes("DataBinding")) {
          types = types.filter((t) => !t.startsWith("{"));
        }
        baseType = types.join(" | ");
      } else {
        baseType = "any";
      }
    } else if (Array.isArray(propSchema["enum"])) {
      baseType = propSchema["enum"].map((v) => `'${String(v)}'`).join(" | ");
    } else if ("type" in propSchema) {
      const t = propSchema["type"];
      if (t === "string") {
        baseType = "string";
      } else if (t === "number" || t === "integer") {
        baseType = "number";
      } else if (t === "boolean") {
        baseType = "boolean";
      } else if (t === "array") {
        const itemsSchema = propSchema["items"];
        if (itemsSchema !== undefined) {
          if (
            isJsonObject(itemsSchema) &&
            itemsSchema["type"] === "object" &&
            isJsonObject(itemsSchema["properties"])
          ) {
            const required = Array.isArray(itemsSchema["required"])
              ? itemsSchema["required"]
              : [];
            const subProps = Object.entries(itemsSchema["properties"]).map(
              ([subKey, subValue]) => {
                const subType = this.mapSchemaToTsType(
                  componentName,
                  `${propName}.${subKey}`,
                  subValue,
                );
                const isSubReq = required.includes(subKey);
                return `${subKey}${isSubReq ? "" : "?"}: ${subType}`;
              },
            );
            baseType = `Array<{${subProps.join("; ")}}>`;
          } else {
            const itemType = this.mapSchemaToTsType(
              componentName,
              propName,
              itemsSchema,
            );
            baseType = itemType.includes("|")
              ? `(${itemType})[]`
              : `${itemType}[]`;
          }
        } else {
          baseType = "any[]";
        }
      } else if (t === "object") {
        if (isJsonObject(propSchema["properties"])) {
          const required = Array.isArray(propSchema["required"])
            ? propSchema["required"]
            : [];
          const subProps = Object.entries(propSchema["properties"]).map(
            ([subKey, subValue]) => {
              const subType = this.mapSchemaToTsType(
                componentName,
                `${propName}.${subKey}`,
                subValue,
              );
              const isSubReq = required.includes(subKey);
              return `${subKey}${isSubReq ? "" : "?"}: ${subType}`;
            },
          );
          baseType = `{${subProps.join("; ")}}`;
        } else {
          baseType = "Record<string, any>";
        }
      }
    }

    if (
      allowsDb &&
      ![
        "A2UIElement",
        "A2UIElement[]",
        "Action",
        "any",
        "DataBinding",
      ].includes(baseType) &&
      !baseType.includes("DataBinding")
    ) {
      baseType = baseType.includes("|")
        ? `(${baseType}) | DataBinding`
        : `${baseType} | DataBinding`;
    }

    return baseType;
  }

  private toComments(description: string | null, indent = ""): string[] {
    if (!description) return [];
    return description
      .trim()
      .split("\n")
      .map((line) => `${indent}// ${line}`);
  }

  /** Compiles component definitions into TypeScript element interfaces. */
  generateComponentDeclarations(): string {
    const declarations: string[] = [];
    for (const name of Object.keys(this.helper.componentProperties).sort()) {
      const props = this.helper.getComponentProperties(name);
      const reqs = this.helper.getComponentRequired(name);

      // Find all action properties to handle renaming.
      const actionProps = props.filter((p) =>
        isAction(this.helper.getPropertySchema(name, p)),
      );

      const compDesc = this.helper.getComponentDescription(name);
      const interfaceLines: string[] = [
        ...this.toComments(compDesc),
        `// Tag: <ui-${toKebabCase(name)}>`,
        `interface ${name} {`,
        "  id?: string;",
      ];

      for (const p of props) {
        const propSchema = this.helper.getPropertySchema(name, p);
        const isReq = reqs.includes(p);

        let tsPropName = p;
        if (actionProps.includes(p)) {
          tsPropName =
            actionProps.length === 1
              ? "onClick"
              : `on${p.charAt(0).toUpperCase()}${p.slice(1)}`;
        }

        const tsType = this.mapSchemaToTsType(name, p, propSchema);
        const optSign = isReq ? "" : "?";

        const propDesc =
          propSchema && typeof propSchema["description"] === "string"
            ? propSchema["description"]
            : null;
        interfaceLines.push(...this.toComments(propDesc, "  "));
        interfaceLines.push(`  ${tsPropName}${optSign}: ${tsType};`);
      }

      interfaceLines.push("}");
      declarations.push(interfaceLines.join("\n"));
    }

    return declarations.join("\n\n");
  }

  /** Compiles function definitions into TypeScript function declarations. */
  generateFunctionDeclarations(): string {
    const declarations: string[] = [];
    for (const name of Object.keys(this.helper.functionProperties).sort()) {
      const props = this.helper.getFunctionProperties(name);
      const reqs = this.helper.getFunctionRequired(name);

      const funcSchema: JsonObject = this.helper.functions[name] ?? {};
      const returnType =
        typeof funcSchema["returnType"] === "string"
          ? funcSchema["returnType"]
          : "any";
      const funcDesc =
        typeof funcSchema["description"] === "string"
          ? funcSchema["description"]
          : null;

      const properties = isJsonObject(funcSchema["properties"])
        ? funcSchema["properties"]
        : {};
      const argsObj = isJsonObject(properties["args"])
        ? properties["args"]
        : {};
      const argsProperties = isJsonObject(argsObj["properties"])
        ? argsObj["properties"]
        : {};

      const argDecls = props.map((p) => {
        const isReq = reqs.includes(p);
        const propSchema = argsProperties[p] ?? {};
        const propType = this.mapSchemaToTsType(name, p, propSchema);
        return `${p}${isReq ? "" : "?"}: ${propType}`;
      });

      const declLines = [
        ...this.toComments(funcDesc),
        `function ${name}(${argDecls.join(", ")}): ${returnType};`,
      ];
      declarations.push(declLines.join("\n"));
    }

    return declarations.join("\n");
  }

  /** Assembles the system prompt component catalog signatures block. */
  catalogDescription(includeSchema = true): string {
    if (!includeSchema) return "";

    const compDecls = this.generateComponentDeclarations();
    const funcDecls = this.generateFunctionDeclarations();

    let catalogInstructions =
      typeof this.helper.catalog["instructions"] === "string"
        ? this.helper.catalog["instructions"]
        : "";
    if (catalogInstructions) {
      catalogInstructions = catalogInstructions.replace(
        "specify any custom error messages directly in the check's 'message'" +
          " property. Do NOT create separate text-display components to display" +
          " validation errors.",
        "specify any custom error messages directly as a named argument" +
          " `message` inside the validation function call (e.g." +
          " `checks=\"{[regex(pattern: '^[a-zA-Z0-9]{3,}$', message: 'Error" +
          " message')]}\"`). Do NOT create separate text-display components to" +
          " display validation errors.",
      );
    }
    const catalogInstructionsBlock = catalogInstructions
      ? `\n\n## Catalog Instructions\n\n${catalogInstructions}`
      : "";

    return DESCRIPTION_TEMPLATE.replace(
      "[COMMON_TYPES]",
      () => COMMON_TYPES_DECLARATIONS,
    )
      .replace("[COMPONENT_DECLARATIONS]", () => compDecls)
      .replace("[FUNCTION_DECLARATIONS]", () => funcDecls)
      .replace("[CATALOG_INSTRUCTIONS_BLOCK]", () => catalogInstructionsBlock);
  }

  generate(options: SystemPromptOptions): string {
    if (options.allowedComponents?.length || options.allowedMessages?.length) {
      this.catalog = withPruning(
        this.catalog,
        options.allowedComponents,
        options.allowedMessages,
      );
      this.helper = new CatalogSchemaHelper(this.catalog.catalogSchema);
      this.catalogId =
        typeof this.catalog.catalogSchema["catalogId"] === "string"
          ? this.catalog.catalogSchema["catalogId"]
          : this.catalogId;
    }

    const prompt = this.catalogDescription(true);

    const parts = [options.roleDescription];

    let rules = ELEMENTAL_RULES.replaceAll("[CATALOG_ID]", this.catalogId);
    if (options.workflowDescription) {
      rules += `\n\n${options.workflowDescription}`;
    }
    parts.push(`## Workflow Description:\n${rules}`);

    if (options.uiDescription) {
      parts.push(`## UI Description:\n${options.uiDescription}`);
    }

    if (options.includeSchema ?? true) {
      parts.push(prompt);
    }

    if (options.examples) {
      parts.push(`### Examples:\n${options.examples}`);
    }

    return parts.join("\n\n");
  }
}
