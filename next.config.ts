import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const filename__ = fileURLToPath(import.meta.url);
const dirname__ = dirname(filename__);

const nextConfig: NextConfig = {
  reactStrictMode: false,
  serverExternalPackages: ["redis", "knex"],
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: resolve(dirname__, "..", ".."),
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
