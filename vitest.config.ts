import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["lib/**/*.test.ts", "components/**/*.test.ts", "tests/**/*.test.ts", "worker/**/*.test.ts"], environment: "node" },
});
