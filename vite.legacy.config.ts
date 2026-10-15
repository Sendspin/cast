import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const opusStub = resolve(__dirname, "src/js/legacy-opus-stub.ts");
// receiver.html loads this exact path
const LEGACY_SCRIPT = "assets/receiver-legacy.js";

// Classic-script build of the receiver for Cast firmware whose Chromium is too old to
// parse the modern module bundle (e.g. Cast 1.28 on Raumfeld speakers). receiver.html
// only loads it on such browsers, so up-to-date devices keep running the modern bundle.
export default defineConfig({
  root: "src",
  base: "./",
  resolve: {
    extensions: [".js", ".json", ".ts"],
    alias: {
      // Opus needs WebCodecs (Chrome 94), so sendspin-js never offers it on these
      // devices; keep its fallback decoder out of the single legacy script.
      "opus-encdec/dist/libopus-decoder.js": opusStub,
      "opus-encdec/src/oggOpusDecoder.js": opusStub,
    },
  },
  build: {
    target: "es2015",
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: false,
    copyPublicDir: false,
    rollupOptions: {
      input: resolve(__dirname, "src/js/legacy.ts"),
      transform: {
        define: {
          // A classic script has no import.meta; resolve relative URLs (the error
          // announcement) against this script, as Rollup's IIFE output does.
          "import.meta.url": `(document.currentScript && document.currentScript.src || new URL("${LEGACY_SCRIPT}", document.baseURI).href)`,
        },
      },
      output: {
        format: "iife",
        codeSplitting: false,
        entryFileNames: LEGACY_SCRIPT,
      },
    },
  },
});
