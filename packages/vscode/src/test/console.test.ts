import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { ProcessConsoleRunner } from '../console.js';

const ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');

suite('console', () => {
  /*
   * Opening a project asks the console several questions at once and two of
   * them are the same question. Each answer costs a Symfony kernel boot, which
   * on a container or a remote machine is the slowest thing the extension
   * does, so asking twice is a boot spent on an answer already coming.
   */
  test('runs one process for a command asked for twice at once', async () => {
    const settings = vscode.workspace.getConfiguration('wicker');
    const previous = settings.inspect<string[]>('console.command')?.workspaceValue;
    const marker = path.join(ROOT, 'wicker-console-probe.txt');
    try {
      // Counted only for a command the extension itself never runs, so its own
      // refresh on the settings change cannot be mistaken for a spawn here.
      await settings.update('console.command', [process.env['npm_node_execpath'] ?? 'node', '-e',
        `if (process.argv.includes('debug:probe')) { require('node:fs').appendFileSync(${
          JSON.stringify(marker)}, 'x'); } process.stdout.write('{}')`,
        '--'], vscode.ConfigurationTarget.Workspace);
      const runner = ProcessConsoleRunner.create(ROOT)!;
      assert.ok(runner);
      const [first, second] = await Promise.all([runner.run(['debug:probe']), runner.run(['debug:probe'])]);
      assert.equal(first.ok, true);
      assert.deepEqual(first, second);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'x', 'one process for two concurrent asks');

      // A later ask is not answered from a stale result: the console describes
      // a project that is still being edited.
      await runner.run(['debug:probe']);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'xx');
    } finally {
      fs.rmSync(marker, { force: true });
      await settings.update('console.command', previous, vscode.ConfigurationTarget.Workspace);
    }
  });
});
