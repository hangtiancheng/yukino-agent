import type { JsonObject } from "@/lib/a2ui/prompt/types";

import shadcnCatalogJson from "./catalog.json";
import commonTypesJson from "./common_types.json";
import serverToClientJson from "./server_to_client.json";

export const SERVER_TO_CLIENT_SCHEMA =
  serverToClientJson as unknown as JsonObject;
export const COMMON_TYPES_SCHEMA = commonTypesJson as unknown as JsonObject;
export const SHADCN_CATALOG_SCHEMA = shadcnCatalogJson as unknown as JsonObject;
