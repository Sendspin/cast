import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./", // Relative paths for GitHub Pages
  resolve: {
    extensions: [".js", ".json", ".ts"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "receiver.html"),
    },
  },
  server: {
    port: 3001,
    host: true, // Allow external access for Cast receiver testing
  },
});
