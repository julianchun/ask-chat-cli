import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    ...(process.platform === "win32" ? { maxWorkers: 2 } : {})
  }
});
