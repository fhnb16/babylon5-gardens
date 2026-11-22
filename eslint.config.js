// ESLint (flat config). Лояльно к унаследованному коду js/: шумные правила
// понижены до предупреждений, чтобы `npm run lint` проходил без правок
// старого кода. Новый код (core/, backends/, pathtracer/, app/) — на TS.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const THREE_BAN = {
  paths: [
    { name: 'three', message: 'core/ не зависит от движка: three только в backends/three/.' },
    { name: 'three-mesh-bvh', message: 'core/ не зависит от движка: BVH three — только в backends/three/.' },
    { name: 'three-gpu-pathtracer', message: 'core/ не зависит от движка.' }
  ],
  patterns: [
    { group: ['three/*', 'three-mesh-bvh/*'], message: 'core/ не зависит от движка: three только в backends/three/.' }
  ]
};

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'android/**/build/**', 'android/.gradle/**', '**/*.min.js',
      'test-results/**', 'playwright-report/**', '**/.threert/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker, ...globals.node }
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off'
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': 'warn',
      'no-cond-assign': 'warn',
      'no-fallthrough': 'warn',
      'no-case-declarations': 'warn',
      'no-sparse-arrays': 'warn',
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'warn',
      'no-self-assign': 'warn',
      'no-loss-of-precision': 'warn',
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'warn',
      'no-unassigned-vars': 'warn'
    }
  },
  {
    /* Ядро не знает о движке. Тестам ядра three разрешён — как эталон
       для сверки чисел (оракул), не как зависимость. */
    files: ['core/**/*.{ts,js,mjs}'],
    ignores: ['core/**/*.test.ts', 'core/test/**'],
    rules: {
      'no-restricted-imports': ['error', THREE_BAN]
    }
  }
);
