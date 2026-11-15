import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    proxy: {
      "/api/nasa-power": {
        target: "https://power.larc.nasa.gov",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/nasa-power/, "/api/temporal/daily/point"),
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 3000,
  },
});
