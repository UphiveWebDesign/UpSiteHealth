import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Resolve the `@/*` alias from tsconfig.json (built into Vite 8).
    tsconfigPaths: true,
    alias: {
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    // Most UpSiteHealth logic runs on the server, so "node" is the default.
    // Component tests opt in with a `// @vitest-environment jsdom` docblock.
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    // Guards the integration database before any test file runs
    // (tests/integration/test-db-guard.ts, docs/operations/testing.md).
    setupFiles: ["./tests/setup.ts"],
    // `prisma dev` (PGlite) serves one connection at a time, so integration
    // test files must not run in parallel against it.
    fileParallelism: !process.env.TEST_DATABASE_URL,
    // A hosted test database (Neon) costs a network round trip per query and
    // seconds per new connection, so database tests get far more than the
    // 5-second default: the slowest (several full syncs) takes 2-4 minutes
    // from here. Unit-only runs keep the defaults.
    ...(process.env.TEST_DATABASE_URL
      ? { testTimeout: 600_000, hookTimeout: 600_000 }
      : {}),
  },
});
