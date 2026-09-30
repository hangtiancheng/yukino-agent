/**
 * Catalog pruning utilities.
 *
 * Ported from `a2ui/schema/catalog.py` (`_collect_refs`,
 * `_prune_defs_by_reachability`, `A2uiCatalog._with_pruned_components`,
 * `A2uiCatalog._with_pruned_messages`, `A2uiCatalog._with_pruned_common_types`,
 * `A2uiCatalog.with_pruning`) targeting protocol v0.9 schemas.
 */

import type { A2uiCatalogSchemas, JsonObject, JsonValue } from "./types";
import { isJsonObject } from "./types";

/** Recursively collects all `$ref` values from a JSON value. */
export function collectRefs(value: JsonValue | undefined): Set<string> {
  const refs = new Set<string>();
  const visit = (node: JsonValue | undefined): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isJsonObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "$ref" && typeof child === "string") {
        refs.add(child);
      } else {
        visit(child);
      }
    }
  };
  visit(value);
  return refs;
}

/** Prunes definitions not reachable from the provided root definition names. */
export function pruneDefsByReachability(
  defs: JsonObject,
  rootDefNames: string[],
  internalRefPrefix = "#/$defs/",
): JsonObject {
  const visited = new Set<string>();
  const queue = [...rootDefNames];

  while (queue.length > 0) {
    const defName = queue.shift() as string;
    if (defName in defs && !visited.has(defName)) {
      visited.add(defName);
      for (const ref of collectRefs(defs[defName])) {
        if (ref.startsWith(internalRefPrefix)) {
          queue.push(
            ref.slice(
              ref.indexOf(internalRefPrefix) + internalRefPrefix.length,
            ),
          );
        }
      }
    }
  }

  return Object.fromEntries(
    Object.entries(defs).filter(([name]) => visited.has(name)),
  );
}

function withPrunedComponents(
  catalogSchema: JsonObject,
  allowedComponents: string[],
): JsonObject {
  if (allowedComponents.length === 0) return catalogSchema;

  const schemaCopy = structuredClone(catalogSchema);
  const allowed = new Set(allowedComponents);

  const components = schemaCopy["components"];
  if (isJsonObject(components)) {
    schemaCopy["components"] = Object.fromEntries(
      Object.entries(components).filter(([name]) => allowed.has(name)),
    );
  }

  const defs = schemaCopy["$defs"];
  if (isJsonObject(defs) && isJsonObject(defs["anyComponent"])) {
    const anyComponent = defs["anyComponent"];
    const oneOf = anyComponent["oneOf"];
    if (Array.isArray(oneOf)) {
      anyComponent["oneOf"] = oneOf.filter((item) => {
        if (!isJsonObject(item) || typeof item["$ref"] !== "string")
          return false;
        const ref = item["$ref"];
        if (!ref.startsWith("#/components/")) return false;
        return allowed.has(ref.split("/").pop() ?? "");
      });
    }
  }

  return schemaCopy;
}

function withPrunedMessages(
  s2cSchema: JsonObject,
  allowedMessages: string[],
): JsonObject {
  if (allowedMessages.length === 0) return s2cSchema;

  const schemaCopy = structuredClone(s2cSchema);
  const allowed = new Set(allowedMessages);

  // 0.9+ style: messages live in $defs and are referenced via oneOf.
  const oneOf = schemaCopy["oneOf"];
  if (Array.isArray(oneOf)) {
    schemaCopy["oneOf"] = oneOf.filter(
      (item) =>
        isJsonObject(item) &&
        typeof item["$ref"] === "string" &&
        item["$ref"].startsWith("#/$defs/") &&
        allowed.has(item["$ref"].split("/").pop() ?? ""),
    );
  }

  const defs = schemaCopy["$defs"];
  if (isJsonObject(defs)) {
    schemaCopy["$defs"] = pruneDefsByReachability(defs, allowedMessages);
  }

  return schemaCopy;
}

function withPrunedCommonTypes(
  catalog: A2uiCatalogSchemas,
): A2uiCatalogSchemas {
  const defs = catalog.commonTypesSchema["$defs"];
  if (!isJsonObject(defs)) return catalog;

  // Roots are ONLY the refs targeting common_types.json from external schemas.
  const externalRefs = collectRefs(catalog.catalogSchema);
  for (const ref of collectRefs(catalog.s2cSchema)) externalRefs.add(ref);

  const rootCommonTypes: string[] = [];
  for (const ref of externalRefs) {
    if (ref.includes("common_types.json#/$defs/")) {
      rootCommonTypes.push(ref.split("#/$defs/").pop() ?? "");
    }
  }

  const commonTypesCopy = structuredClone(catalog.commonTypesSchema);
  commonTypesCopy["$defs"] = pruneDefsByReachability(
    structuredClone(defs),
    rootCommonTypes,
  );

  return { ...catalog, commonTypesSchema: commonTypesCopy };
}

/**
 * Returns a new set of catalog schemas with pruned components and messages.
 * Unused common types are always pruned by reachability, mirroring
 * `A2uiCatalog.with_pruning`.
 */
export function withPruning(
  catalog: A2uiCatalogSchemas,
  allowedComponents?: string[],
  allowedMessages?: string[],
): A2uiCatalogSchemas {
  let result = catalog;
  if (allowedComponents && allowedComponents.length > 0) {
    result = {
      ...result,
      catalogSchema: withPrunedComponents(
        result.catalogSchema,
        allowedComponents,
      ),
    };
  }
  if (allowedMessages && allowedMessages.length > 0) {
    result = {
      ...result,
      s2cSchema: withPrunedMessages(result.s2cSchema, allowedMessages),
    };
  }
  return withPrunedCommonTypes(result);
}
