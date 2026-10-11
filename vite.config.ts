import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const saRoot = fileURLToPath(new URL("./.sa-cache/frontend/src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@sa": saRoot } },
  build: { outDir: "dist", emptyOutDir: true },
});
