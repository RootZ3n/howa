import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  resolve: {
    alias: {
      // `@howa/*` maps to the package source root; every import in src/ and
      // tests/ uses it.
      "@howa": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.HOWA_UI_PORT ?? 5180),
    strictPort: false,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.HOWA_PORT ?? 18799}`,
    },
  },
  preview: {
    port: Number(process.env.HOWA_UI_PORT ?? 5180),
    strictPort: false,
  },
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["../../tests/**/*.test.ts"],
  },
});
