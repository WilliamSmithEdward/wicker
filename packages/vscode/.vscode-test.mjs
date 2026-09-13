import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

// Start in a multi-folder workspace: switching from a single folder during a
// test can restart the extension host. Keep its writable settings in the cache.
const cache = new URL('./.vscode-test/', import.meta.url);
mkdirSync(cache, { recursive: true });
const workspace = new URL('symfony.code-workspace', cache);
writeFileSync(workspace, JSON.stringify({
  folders: ['symfony-app', 'symfony-app/nested-app'].map((folder) => ({
    path: fileURLToPath(new URL(`./fixtures/${folder}`, import.meta.url)),
  })),
}, null, 2));

export default defineConfig({
  label: 'integration',
  files: 'out/test/**/*.test.js',
  // The fixture Symfony project is the workspace under test, so the extension
  // activates and indexes exactly as it would for a real project.
  workspaceFolder: fileURLToPath(workspace),
  version: 'stable',
  mocha: {
    ui: 'tdd',
    timeout: 25000,
  },
  launchArgs: [
    // Other extensions would change which providers answer, making results
    // depend on whatever the developer happens to have installed.
    '--disable-extensions',
    '--user-data-dir', fileURLToPath(new URL('integration-user-data/', cache)),
  ],
});
