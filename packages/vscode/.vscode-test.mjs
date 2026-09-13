import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  label: 'integration',
  files: 'out/test/**/*.test.js',
  // The fixture Symfony project is the workspace under test, so the extension
  // activates and indexes exactly as it would for a real project.
  workspaceFolder: './fixtures/symfony-app',
  version: 'stable',
  mocha: {
    ui: 'tdd',
    timeout: 25000,
  },
  launchArgs: [
    // Other extensions would change which providers answer, making results
    // depend on whatever the developer happens to have installed.
    '--disable-extensions',
  ],
});
