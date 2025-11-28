import { defineConfig } from "vite";

export default defineConfig({
  base: "./", // Relative paths for GitHub Pages
  resolve: {
    extensions: [".js", ".json", ".ts"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 3001,
    host: true, // Allow external access for Cast receiver testing
  },
});
