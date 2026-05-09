import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.VITE_API_TARGET ?? `http://localhost:${process.env.KINDLEFLOW_SERVER_PORT ?? 3000}`;

export default defineConfig({
  root: "client",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/files": apiTarget
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
