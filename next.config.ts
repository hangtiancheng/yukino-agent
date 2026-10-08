import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const filename__ = fileURLToPath(import.meta.url);
const dirname__ = dirname(filename__);

const nextConfig: NextConfig = {
  // The A2UI MessageProcessor is a stateful external store; StrictMode's dev
  // double-effect replays already-created surfaces on re-subscription.
  reactStrictMode: false,
  // Native/binary deps with dynamic requires should not be bundled by webpack.
  serverExternalPackages: ["redis", "knex"],
  // Without this, visiting the dev server via 127.0.0.1 gets client dev
  // resources blocked (only localhost is trusted), so no client JS runs.
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: resolve(dirname__, "..", ".."),
  },
};

// Wires up i18n/request.ts (the default ./i18n/request.ts location) for
// next-intl on both webpack and Turbopack.
const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
