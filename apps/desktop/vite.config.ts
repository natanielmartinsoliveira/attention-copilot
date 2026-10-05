import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/socket.io": { target: "http://127.0.0.1:4317", ws: true },
    },
  },
  build: { outDir: "../../dist-ui", emptyOutDir: true },
});
