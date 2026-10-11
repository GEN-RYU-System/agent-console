import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const saRoot = fileURLToPath(new URL("./.sa-cache/frontend/src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@sa": saRoot } },
  test: {
    globals: true,
    include: ["tests/unit/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
