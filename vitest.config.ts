import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/**/*.test.{js,mjs,ts}',
      'core/**/*.test.ts',
      'backends/**/*.test.ts',
      'pathtracer/**/*.test.ts'
    ],
    /* tests/browser — Playwright, не Vitest */
    exclude: [...configDefaults.exclude, 'tests/browser/**'],
    environment: 'node'
  }
});
