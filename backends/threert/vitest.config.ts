import { defineConfig } from 'vitest/config';

/* Tests of the native ThreeRT backend that run in plain Node (no GPU, no ThreeRT client).
   The repo root tsconfig excludes backends/threert (it is typechecked by the ThreeRT CLI), but the root
   vitest.config.ts globs backends/**\/*.test.ts, so these tests also run under `npm test`.
   Standalone:  npx vitest run --config backends/threert/vitest.config.ts */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['spike/**', 'node_modules/**'],
    environment: 'node',
  },
});
