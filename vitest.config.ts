import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } },
      { test: { name: "dom", include: ["tests/dom/**/*.test.ts"], environment: "jsdom" } },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
        },
      },
      { test: { name: "security", include: ["tests/security/**/*.test.ts"], environment: "node" } },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/background/index.ts", "src/popup/index.ts", "src/content/index.ts"],
      reporter: ["text", "html"],
    },
  },
});
