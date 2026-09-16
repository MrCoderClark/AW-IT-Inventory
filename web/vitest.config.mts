import { defineConfig } from "vitest/config";
import path from "node:path";

// Minimal Vitest config for component tests (jsdom + Testing Library).
// Written by /test on first setup; extend as the suite grows.
// Vite 8 transforms JSX with oxc (automatic runtime by default), so no
// explicit JSX/plugin config is needed here.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Only pick up co-located component/unit tests, not the app or e2e.
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
});
