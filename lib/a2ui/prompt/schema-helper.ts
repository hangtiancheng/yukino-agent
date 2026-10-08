/**
 * Dynamic schema crawler for A2UI catalogs.
 *
 * Ported from the A2UI Python agent SDK `CatalogSchemaHelper`
 * (`a2ui/inference_formats/experimental/express/schema_helper.py`) combined
 * with the component/function selection rules of `Catalog.from_json`
 * (`a2ui/core/catalog/catalog.py`).
 */

import type { JsonObject, JsonValue } from "./types";
import { isJsonObject } from "./types";

/** Recursively finds enum definitions inside a JSON schema (oneOf/anyOf aware). */
export function findSchemaEnum(
  propSchema: JsonValue | undefined,
): JsonValue[] | null {
  if (!isJsonObject(propSchema)) return null;
  if (Array.isArray(propSchema["enum"])) return propSchema["enum"];
  const subs = [
    ...(Array.isArray(propSchema["oneOf"]) ? propSchema["oneOf"] : []),
    ...(Array.isArray(propSchema["anyOf"]) ? propSchema["anyOf"] : []),
  ];
  for (const sub of subs) {
    const enumVal = findSchemaEnum(sub);
    if (enumVal) return enumVal;
  }
  return null;
}

function permittedNames(
  catalogSchema: JsonObject,
  defName: string,
  refPrefix: string,
): Set<string> {
  const names = new Set<string>();
  const defs = catalogSchema["$defs"];
  if (!isJsonObject(defs)) return names;
  const anyDef = defs[defName];
  if (!isJsonObject(anyDef) || !Array.isArray(anyDef["oneOf"])) return names;
  for (const item of anyDef["oneOf"]) {
    if (!isJsonObject(item)) continue;
    const ref = item["$ref"];
    if (typeof ref === "string" && ref.startsWith(refPrefix)) {
      names.add(ref.split("/").pop() ?? "");
    }
  }
  return names;
}

/** Yields the schema itself followed by its `allOf` sub-schemas. */
function subSchemas(schema: JsonObject): JsonObject[] {
  const subs: JsonObject[] = [schema];
  if (Array.isArray(schema["allOf"])) {
    for (const sub of schema["allOf"]) {
      if (isJsonObject(sub)) subs.push(sub);
    }
  }
  return subs;
}

export class CatalogSchemaHelper {
  /** The raw catalog JSON schema. */
  readonly catalog: JsonObject;
  /** Component name -> raw component schema entry. */
  readonly components: Record<string, JsonObject>;
  /** Function name -> raw function schema entry. */
  readonly functions: Record<string, JsonObject>;

  readonly componentProperties: Record<string, string[]> = {};
  readonly componentRequired: Record<string, string[]> = {};
  readonly componentIsCheckable: Record<string, boolean> = {};
  readonly functionProperties: Record<string, string[]> = {};
  readonly functionRequired: Record<string, string[]> = {};

  constructor(catalogSchema: JsonObject) {
    this.catalog = catalogSchema;

    const componentsMap = isJsonObject(catalogSchema["components"])
      ? catalogSchema["components"]
      : {};
    const permittedComponents = permittedNames(
      catalogSchema,
      "anyComponent",
      "#/components/",
    );
    this.components = {};
    for (const [name, schema] of Object.entries(componentsMap)) {
      if (!isJsonObject(schema)) continue;
      if (permittedComponents.size > 0 && !permittedComponents.has(name))
        continue;
      this.components[name] = schema;
    }

    const functionsMap = isJsonObject(catalogSchema["functions"])
      ? catalogSchema["functions"]
      : {};
    const permittedFunctions = permittedNames(
      catalogSchema,
      "anyFunction",
      "#/functions/",
    );
    this.functions = {};
    for (const [name, schema] of Object.entries(functionsMap)) {
      if (!isJsonObject(schema)) continue;
      if (permittedFunctions.size > 0 && !permittedFunctions.has(name))
        continue;
      this.functions[name] = schema;
    }

    this.loadMappings();
  }

  private loadMappings(): void {
    for (const [name, schema] of Object.entries(this.components)) {
      const props: string[] = [];
      const reqs: string[] = [];
      let isCheckable = false;

      for (const sub of subSchemas(schema)) {
        const ref = sub["$ref"];
        if (typeof ref === "string" && ref.includes("Checkable")) {
          isCheckable = true;
        }
        if (isJsonObject(sub["properties"])) {
          for (const key of Object.keys(sub["properties"])) {
            if (!props.includes(key)) props.push(key);
          }
        }
        if (Array.isArray(sub["required"])) {
          for (const r of sub["required"]) {
            if (typeof r === "string") reqs.push(r);
          }
        }
      }

      // Filter out structural properties `component` and `id`.
      const orderedKeys = props.filter((k) => k !== "component" && k !== "id");
      // If it's checkable, add `checks` at the end.
      if (isCheckable) orderedKeys.push("checks");

      this.componentProperties[name] = orderedKeys;
      this.componentRequired[name] = reqs;
      this.componentIsCheckable[name] = isCheckable;
    }

    for (const [name, schema] of Object.entries(this.functions)) {
      const props: string[] = [];
      const reqs: string[] = [];
      for (const sub of subSchemas(schema)) {
        if (!isJsonObject(sub["properties"])) continue;
        const argsObj = sub["properties"]["args"];
        if (!isJsonObject(argsObj)) continue;
        if (isJsonObject(argsObj["properties"])) {
          for (const key of Object.keys(argsObj["properties"])) {
            if (!props.includes(key)) props.push(key);
          }
        }
        if (Array.isArray(argsObj["required"])) {
          for (const r of argsObj["required"]) {
            if (typeof r === "string") reqs.push(r);
          }
        }
      }
      this.functionProperties[name] = props;
      this.functionRequired[name] = reqs;
    }
  }

  getComponentProperties(name: string): string[] {
    return this.componentProperties[name] ?? [];
  }

  getComponentRequired(name: string): string[] {
    return this.componentRequired[name] ?? [];
  }

  isCheckable(name: string): boolean {
    return this.componentIsCheckable[name] ?? false;
  }

  getFunctionProperties(name: string): string[] {
    return this.functionProperties[name] ?? [];
  }

  getFunctionRequired(name: string): string[] {
    return this.functionRequired[name] ?? [];
  }

  getFunctionPropertySchema(
    fnName: string,
    propName: string,
  ): JsonObject | null {
    const fnSchema = this.functions[fnName];
    if (!fnSchema) return null;
    for (const sub of subSchemas(fnSchema)) {
      if (!isJsonObject(sub["properties"])) continue;
      const argsObj = sub["properties"]["args"];
      if (!isJsonObject(argsObj) || !isJsonObject(argsObj["properties"]))
        continue;
      const propSchema = argsObj["properties"][propName];
      if (propSchema !== undefined && isJsonObject(propSchema))
        return propSchema;
    }
    return null;
  }

  getComponentDescription(name: string): string | null {
    const schema = this.components[name];
    if (!schema) return null;
    if (typeof schema["description"] === "string") return schema["description"];
    if (Array.isArray(schema["allOf"])) {
      for (const sub of schema["allOf"]) {
        if (isJsonObject(sub) && typeof sub["description"] === "string") {
          return sub["description"];
        }
      }
    }
    return null;
  }

  getFunctionDescription(name: string): string | null {
    const schema = this.functions[name];
    if (!schema) return null;
    return typeof schema["description"] === "string"
      ? schema["description"]
      : null;
  }

  /** Crawls all sub-schemas of a component to retrieve a property's schema. */
  getPropertySchema(
    componentName: string,
    propertyName: string,
  ): JsonObject | null {
    const schema = this.components[componentName];
    if (!schema) return null;
    for (const sub of subSchemas(schema)) {
      if (
        isJsonObject(sub["properties"]) &&
        propertyName in sub["properties"] &&
        isJsonObject(sub["properties"][propertyName])
      ) {
        return sub["properties"][propertyName];
      }
    }
    return null;
  }
}
