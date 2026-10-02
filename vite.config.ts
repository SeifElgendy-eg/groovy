import { defineConfig } from "vite";

// Relative base: the built folder is served from a loopback server (or any sub-path), never a fixed root.
export default defineConfig({
  base: "./",
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173 },
});
