import { defineConfig } from "vite";

const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// Relative base: the built folder is served from a loopback server (or any sub-path), never a fixed root.
export default defineConfig({
  base: "./",
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  // Cross-origin isolation: lets the botox work share memory between its workers (several cores).
  // The kiosk launcher sends the same headers.
  server: { host: "127.0.0.1", port: 5173, headers: ISOLATION },
  preview: { headers: ISOLATION },
});
