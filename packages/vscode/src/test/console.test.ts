import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { ProcessConsoleRunner } from '../console.js';

const ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');

suite('console', () => {
  /*
   * A template created or deleted changes which names resolve and nothing the
   * console reports. Asking it again for every new partial cost six kernel
   * boots per file; a PHP file can carry a route, a component or an extension,
   * so that one still asks.
   */
  test('a new template does not ask the console again, and a new PHP file does', async () => {
    const settings = vscode.workspace.getConfiguration('wicker');
    const previousCommand = settings.inspect<string[]>('console.command')?.workspaceValue;
    const previousEnabled = settings.inspect<boolean>('console.enabled')?.workspaceValue;
    const marker = path.join(ROOT, 'wicker-console-boots.txt');
    const template = vscode.Uri.file(path.join(ROOT, 'templates/wicker_console_probe.html.twig'));
    const php = vscode.Uri.file(path.join(ROOT, 'src/WickerConsoleProbe.php'));
    const config = vscode.Uri.file(path.join(ROOT, 'config/packages/wicker_console_probe.yaml'));
    const boots = (): number => { try { return fs.readFileSync(marker, 'utf8').length; } catch { return 0; } };
    const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      await settings.update('console.enabled', true, vscode.ConfigurationTarget.Workspace);
      await settings.update('console.command', [process.env['npm_node_execpath'] ?? 'node', '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('{}')`,
        '--'], vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
      await settled();
      const before = boots();
      assert.ok(before > 0, 'the reindex should have asked the console');

      await vscode.workspace.fs.writeFile(template, Buffer.from('<p>probe</p>'));
      await settled();
      assert.equal(boots(), before, 'a new template must not boot the console');

      // PHP can register an extension, a route or a component: three questions.
      // Where assets live, where controllers are looked for and where the
      // project is come from configuration, and those answers are kept.
      await vscode.workspace.fs.writeFile(php, Buffer.from('<?php class WickerConsoleProbe {}'));
      await settled();
      assert.equal(boots(), before + 3, 'a PHP file asks for extensions, routes and components only');

      // Configuration can move anything, so every answer is asked for again.
      await vscode.workspace.fs.writeFile(config, Buffer.from('wicker_probe: {}\n'));
      await settled();
      assert.equal(boots(), before + 3 + 6, 'a configuration change asks everything again');
    } finally {
      for (const uri of [template, php, config]) { try { await vscode.workspace.fs.delete(uri); } catch { /* never written */ } }
      fs.rmSync(marker, { force: true });
      await settings.update('console.command', previousCommand, vscode.ConfigurationTarget.Workspace);
      await settings.update('console.enabled', previousEnabled, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
    }
  });

  /*
   * A command still running when its time is up is killed, and the reason
   * has to say so: "Command failed" with no output reads as a broken console,
   * when the first answer on a cold container is the one most likely to be
   * slow rather than broken.
   */
  test('a command that runs out of time says how long it was given', async () => {
    const settings = vscode.workspace.getConfiguration('wicker');
    const previous = settings.inspect<string[]>('console.command')?.workspaceValue;
    try {
      await settings.update('console.command', [process.env['npm_node_execpath'] ?? 'node', '-e',
        "setTimeout(() => process.stdout.write('{}'), 2000)", '--'], vscode.ConfigurationTarget.Workspace);
      const runner = ProcessConsoleRunner.create(ROOT, 300)!;
      assert.ok(runner);
      const result = await runner.run(['debug:probe']);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'no answer within 0.3 seconds');
    } finally {
      await settings.update('console.command', previous, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
    }
  });

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
