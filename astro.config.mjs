// @ts-check
import { defineConfig } from "astro/config";

// La interfaz se compila a estático (dist/) y Tauri la carga en su ventana.
export default defineConfig({
  output: "static",
  server: { port: 4321, host: "127.0.0.1" },
  build: { assets: "assets" },
  vite: {
    clearScreen: false,
    server: { strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  },
});
