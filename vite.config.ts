import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// BASE_PATH is the URL prefix the site is served under, e.g. /grdnr/ on GitHub Pages
// or /grdnr/pr-preview/pr-3/ for a PR preview. `vite build --base=...` also works.
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  resolve: { alias: { "@": "/src" } },
  build: { outDir: "dist" },
});
