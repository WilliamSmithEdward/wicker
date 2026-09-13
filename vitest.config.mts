import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // The VS Code integration suite imports the `vscode` module, which only
    // exists inside a running editor. It is driven by `vscode-test` instead.
    exclude: ['packages/vscode/src/test/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts'],
    },
  },
});
