import { defineConfig } from "vitest/config";
import path from "node:path";

// Minimal Vitest config for component tests (jsdom + Testing Library).
// Written by /test on first setup; extend as the suite grows.
// Vite 8 transforms JSX with oxc (automatic runtime by default), so no
// explicit JSX/plugin config is needed here.
export default defineConfig({
  test: {
    // Default to node: most tests are pure logic/db/route/action tests that need
    // no DOM, so creating a jsdom per file was ~half the suite's wall-clock. The
    // component tests (.test.tsx) opt into jsdom with a top-of-file pragma
    //   // @vitest-environment jsdom
    // (the same mechanism the node route tests already use for `node`). This keeps
    // full per-file isolation — unlike `isolate:false` or `pool:'vmThreads'`, the
    // latter of which would also break the undici `instanceof File` checks the
    // route tests rely on, since it runs files in separate VM realms.
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Only pick up co-located component/unit tests, not the app or e2e.
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // `server-only` is a bundle-time marker with no test runtime; point it at
      // a no-op so server modules (db helpers) can load under Vitest.
      "server-only": path.resolve(
        import.meta.dirname,
        "./src/test/empty-module.ts",
      ),
    },
  },
});
