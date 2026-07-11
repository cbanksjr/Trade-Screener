import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiProtocol = env.API_HTTPS === "false" ? "http" : "https";
  return {
    plugins: [react()],
    test: {
      exclude: ["**/node_modules/**", "**/dist/**", "dist-server/**"]
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api": {
          target: `${apiProtocol}://127.0.0.1:4173`,
          secure: false
        }
      }
    }
  };
});
