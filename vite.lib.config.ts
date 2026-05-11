import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  /** Avoid copying `public/` into `dist/` when publishing the library. */
  publicDir: false,
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: ["three"],
      output: {
        preserveModules: false,
      },
    },
  },
});
