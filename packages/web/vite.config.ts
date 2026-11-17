import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The backend serves the built panel, so API calls are same-origin. `pnpm dev` proxies them.
const backend = process.env.FORGE_BACKEND ?? "http://127.0.0.1:7420";
const api = ["/runs", "/steps", "/projects", "/auth", "/login", "/health"];

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: {
    proxy: {
      ...Object.fromEntries(api.map((path) => [path, { target: backend, changeOrigin: false }])),
      "/ws": { target: backend.replace("http", "ws"), ws: true },
    },
  },
});
