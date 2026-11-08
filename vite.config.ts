import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^monaco-editor$/,
        replacement: fileURLToPath(
          new URL(
            "./node_modules/monaco-editor/esm/vs/editor/editor.main.js",
            import.meta.url,
          ),
        ),
      },
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/.tools/**", "**/test-results/**"],
    },
  },
  clearScreen: false,
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: { monaco: ["monaco-editor"], pdf: ["pdfjs-dist"] },
      },
    },
  },
  test: { environment: "jsdom", include: ["tests/**/*.test.{ts,tsx,mjs}"] },
});
