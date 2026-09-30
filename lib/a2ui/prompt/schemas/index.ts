/**
 * Schema resources for the prompt generators.
 *
 * - `server_to_client.json` / `common_types.json`: vendored copies of the
 *   published A2UI v0.9 protocol schemas, byte-identical to
 *   https://a2ui.org/specification/v0_9/json/*.json (refresh via curl if the
 *   spec ever changes).
 * - `catalog.json`: copy of the package root `catalog.json`, kept in sync by
 *   `scripts/catalog.ts` (`npm run catalog`).
 */

import type { JsonObject } from "../types";

import shadcnCatalogJson from "./catalog.json";
import commonTypesJson from "./common_types.json";
import serverToClientJson from "./server_to_client.json";

// TS infers union members with synthetic `?: undefined` props for
// heterogeneous JSON arrays, so the literal types need a cast to JsonObject.
export const SERVER_TO_CLIENT_SCHEMA =
  serverToClientJson as unknown as JsonObject;
export const COMMON_TYPES_SCHEMA = commonTypesJson as unknown as JsonObject;
export const SHADCN_CATALOG_SCHEMA = shadcnCatalogJson as unknown as JsonObject;
