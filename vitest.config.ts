import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  // Node tests share the project config. The native ThreeRT build resolves its SDK separately.
  tsconfig: './tsconfig.json',
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
