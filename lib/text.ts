/**
 * Coerce an unknown value to a display string.
 *
 * Values that would stringify to the useless `[object Object]` (plain objects,
 * arrays) fall back to `fallback` instead, so metadata reads such as
 * `asString(doc.metadata.doc_id)` stay honest. Strings pass through verbatim;
 * numbers, bigints and booleans use their normal `String()` form.
 */
export function asString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      return fallback;
  }
}

/**
 * Render a JSON-schema enum value for prompt text. Strings pass through
 * verbatim; everything else (numbers, booleans, null, objects) is serialized as
 * JSON so objects never degrade to `[object Object]`.
 */
export function enumLabel(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}
