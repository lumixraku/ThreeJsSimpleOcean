import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "./",
  build: {
    target: "es2022",
  },
});
