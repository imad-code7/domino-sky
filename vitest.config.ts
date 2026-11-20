import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  test: {
    include: ["server/**/*.test.ts"],
    environment: "node",
  },
});
