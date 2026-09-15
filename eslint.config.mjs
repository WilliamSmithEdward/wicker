import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', '**/.vscode-test/**', '**/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level tooling configs belong to no package tsconfig, so they
          // are linted against the default project rather than left unparsed.
          allowDefaultProject: [
            '*.mjs',
            '*.mts',
            '*.js',
            'packages/*/*.js',
            'packages/*/*.mjs',
            'packages/*/scripts/*.mjs',
            'packages/*/scripts/*.cjs',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Non-ASCII in source is a deliberate decision here, not an accident.
      'no-irregular-whitespace': ['error', { skipStrings: false, skipComments: false }],
      eqeqeq: ['error', 'always'],
      'no-console': 'warn',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Integration tests print the environment they observed. When one fails
      // inside a throwaway editor instance, that output is the only evidence.
      'no-console': 'off',
    },
  },
  {
    // Tooling and build scripts are linted for correctness but not
    // type-checked: they sit in the default project, where `import.meta` and
    // CommonJS globals resolve to error types and every type-aware rule
    // reports noise rather than defects.
    files: [
      '*.mjs',
      '*.mts',
      '*.js',
      'packages/*/*.js',
      'packages/*/*.mjs',
      'packages/*/scripts/*.mjs',
    ],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      // Build scripts are CommonJS by design; the editor loads them with require.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
