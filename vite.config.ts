import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "./",
  publicDir: "public",
  build: {
    outDir: "dist-demo",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: "index.html",
    },
  },
});
