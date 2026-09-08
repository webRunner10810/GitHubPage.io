import globals from 'globals';

/** Flat config. The app ships as native ES modules with no build step. */
export default [
  {
    ignores: ['node_modules/**', 'test-results/**', 'playwright-report/**'],
  },
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-implicit-globals': 'error',
      'no-return-await': 'error',
      'require-await': 'error',
      'no-promise-executor-return': 'error',
      'no-await-in-loop': 'off',
      curly: ['error', 'multi-line'],
    },
  },
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'error', 'prefer-const': 'error' },
  },
  {
    files: ['test/unit/**/*.js', 'tools/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { 'no-unused-vars': 'error', 'prefer-const': 'error' },
  },
  {
    files: ['test/e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { 'no-unused-vars': 'error', 'prefer-const': 'error' },
  },
  {
    files: ['proxy/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.worker, ...globals.node },
    },
    rules: { 'no-unused-vars': 'error', 'prefer-const': 'error' },
  },
];
