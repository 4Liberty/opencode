import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"

// The extension is loaded unpacked from dist/. The service worker must keep a stable name for the
// manifest; everything else is content-hashed.
export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: "public",
  base: "./",
  plugins: [...tailwindcss(), solidPlugin()],
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome130",
    minify: mode !== "development",
    sourcemap: mode === "development" ? "inline" : false,
    modulePreload: false,
    rolldownOptions: {
      input: {
        sidepanel: fileURLToPath(new URL("./sidepanel.html", import.meta.url)),
        background: fileURLToPath(new URL("./src/background/index.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
      },
    },
  },
}))
