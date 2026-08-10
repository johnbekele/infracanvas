import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

/**
 * One flat config for the whole workspace. Individual packages inherit it by
 * ancestor lookup, so there is a single place to change a rule.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.d.ts',
      'pnpm-lock.yaml',
      // Golden files are expected emitter output compared byte for byte. They
      // reference variables their surrounding project declares, so linting or
      // type-checking them here would be checking a fragment as a program.
      '**/__golden__/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      // Gate 2 also scans the diff for `any`, but catching it in the editor is
      // cheaper than catching it in CI.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-implicit-coercion': 'error',
      // Floating promises are the most common source of silently swallowed
      // failures in the job workers.
      'no-return-await': 'error',
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  {
    // shadcn-style primitives export their variant helpers alongside the
    // component by convention, which fast refresh cannot statically verify.
    files: ['apps/web/src/components/ui/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  {
    // Scripts are operational tooling: they run in Node, log to stdout by
    // design, and are not part of the shipped bundle.
    files: ['scripts/**/*.mjs', '*.config.{js,mjs,ts}'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
