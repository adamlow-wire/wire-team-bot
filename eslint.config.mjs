// @ts-check
import tseslint from "typescript-eslint";

/**
 * ESLint configuration enforcing hexagonal architecture dependency rules
 * (PLAN §1.1):
 *
 *  domain      → nothing from other project layers
 *  application → domain + ports only (no infra/wire/persistence)
 *  infrastructure → application + domain (never imported in reverse)
 *  app         → all layers (composition root only)
 */
export default tseslint.config(
  {
    // Apply to all TypeScript source and test files.
    files: ["src/**/*.ts", "tests/**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      // Warn instead of error so the rules are informative without blocking builds
      // while the team evaluates any edge cases. Change to "error" when stable.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // domain layer must not import anything from application, infrastructure, or app.
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            { group: ["**/application/**"], message: "domain must not import from application" },
            { group: ["**/infrastructure/**"], message: "domain must not import from infrastructure" },
            { group: ["**/app/**"], message: "domain must not import from app" },
            { group: ["wire-apps-js-sdk"], message: "domain must not import the Wire SDK" },
            { group: ["@prisma/client"], message: "domain must not import Prisma" },
          ],
        },
      ],
    },
  },
  {
    // application layer must not import infrastructure or app, and must never use the Wire SDK or Prisma directly.
    files: ["src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            { group: ["**/infrastructure/**"], message: "application must not import from infrastructure" },
            { group: ["**/app/**"], message: "application must not import from app" },
            { group: ["wire-apps-js-sdk"], message: "application must not import the Wire SDK directly" },
            { group: ["@prisma/client"], message: "application must not import Prisma directly" },
          ],
        },
      ],
    },
  },
  {
    // Ignore generated files and build output.
    ignores: ["dist/**", "node_modules/**", "prisma/migrations/**"],
  },
);
