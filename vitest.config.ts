import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text"], include: ["src/**/*.ts"], exclude: ["src/**/*.d.ts", "src/app/main.ts"] },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Stub out the Wire SDK to avoid its WASM transitive dep in tests.
      "wire-apps-js-sdk": path.resolve(__dirname, "./__mocks__/wire-apps-js-sdk.ts"),
    },
  },
});
