import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import globals from "globals";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "eslint.config.mjs",
    "postcss.config.mjs",
    // Vendored shadcn/ui + catalog implementation ported from the a2ui repo
    // (upstream excludes them from linting as well).
    "catalog/components/**",
    "components/ui/**",
    // Generated Prisma client.
    "generated/**",
    // Category B managed git checkouts (cloned third-party repos, not our source).
    "data/workspaces/**",
    // Legacy DevFlow-AI source kept for reference during migration.
    "DevFlow-AI/**",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);

export default eslintConfig;
