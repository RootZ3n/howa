import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  resolve: {
    alias: {
      // `@colosseum/*` is the original alias and is preserved verbatim —
      // every existing import in src/ and tests/ uses it, and renaming the
      // alias would require churning every file with no functional gain.
      // The brand is Howa; the internal source path label is just a label.
      "@colosseum": fileURLToPath(new URL("./src", import.meta.url)),
      "@howa": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.HOWA_UI_PORT ?? process.env.COLOSSEUM_UI_PORT ?? 5180),
    strictPort: false,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.HOWA_PORT ?? process.env.COLOSSEUM_PORT ?? 18799}`,
    },
  },
  preview: {
    port: Number(process.env.HOWA_UI_PORT ?? process.env.COLOSSEUM_UI_PORT ?? 5180),
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
