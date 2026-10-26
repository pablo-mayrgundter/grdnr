import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Asset URLs are relative ("./assets/…"), and routing is in the hash, so one build works at
// any address: https://grdnr.life/, a PR preview under /pr-preview/pr-N/, or a copy anywhere else.
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@": "/src" } },
  build: { outDir: "dist" },
});
