import { defineConfig } from "prisma/config";

// Load .env when present so CLI commands (generate / db push / migrate) use
// the same database URL as the runtime configuration.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file; fall through to the default
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://yukino:yukino@127.0.0.1:5433/yukino_agent",
  },
});
