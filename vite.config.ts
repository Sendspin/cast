import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: "src",
  base: "./", // Relative paths for GitHub Pages
  resolve: {
    extensions: [".js", ".json", ".ts"],
  },
  build: {
    // Cast devices can run older Chromium runtimes. Keep syntax conservative
    // so the receiver app can parse and boot on legacy firmware.
    // Devices older than this get the legacy build (vite.legacy.config.ts) instead:
    // keep the syntax check that picks it in receiver.html in step with this target.
    target: "chrome80",
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "src/index.html"),
        receiver: resolve(__dirname, "src/receiver.html"),
      },
    },
  },
  server: {
    port: 3001,
    host: true, // Allow external access for Cast receiver testing
  },
});
