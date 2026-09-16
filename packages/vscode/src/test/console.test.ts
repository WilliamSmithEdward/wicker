import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { ProcessConsoleRunner } from '../console.js';
import { ConsoleMemory } from '../consoleMemory.js';
import { SessionManager, type ProjectSession } from '../session.js';
import { until } from './support.js';

const ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');

suite('console', () => {
  /*
   * The last answers stand in until the console answers, so a project opened
   * for the second time is drawn complete at once, and the configuration
   * answers memory holds are asked for only after the ones a person waits
   * for. A configuration that changed while the editor was closed is read
   * again from the console's answer.
   */
  test('draws a second opening from the last answers and confirms configuration after the content', async () => {
    const settings = vscode.workspace.getConfiguration('wicker');
    const previousCommand = settings.inspect<string[]>('console.command')?.workspaceValue;
    const previousEnabled = settings.inspect<boolean>('console.enabled')?.workspaceValue;
    const marker = path.join(ROOT, 'wicker-console-order.txt');
    const asked = (): string[] => { try { return fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
    const remembered = new Map<string, unknown>();
    const owned: SessionManager[] = [];
    let initialized: Promise<void> | undefined;
    const sessionsWithMemory = (): SessionManager => {
      const sessions = new SessionManager(new ConsoleMemory({
        keys: () => [...remembered.keys()],
        get: <T>(key: string, fallback?: T): T | undefined => (remembered.get(key) as T | undefined) ?? fallback,
        update: (key: string, value: unknown) => { remembered.set(key, value); return Promise.resolve(); },
      }));
      owned.push(sessions);
      return sessions;
    };
    const rootSession = (sessions: SessionManager): ProjectSession | undefined => sessions.all()
      .find((session) => session.fileSystem.toUri(session.project.root).toString() === vscode.Uri.file(ROOT).toString());
    // A console whose route and Stimulus directory are its own, so both can be
    // told from the fixture's. Only the root project's asks are recorded: the
    // nested project runs the same command.
    const fakeConsole = (delayMs: number, controllers: string): string[] => [process.env['npm_node_execpath'] ?? 'node', '-e', `
      const args = process.argv; const root = process.cwd();
      const which = args.find((arg) => arg.startsWith('debug:')) + (args.includes('asset_mapper') ? ' asset_mapper' : args.includes('stimulus') ? ' stimulus' : '');
      if (/symfony-app$/.test(root)) { require('node:fs').appendFileSync(${JSON.stringify(marker)}, which + '\\n'); }
      const answer = args.includes('debug:router') ? { wicker_remembered: { path: '/remembered', method: 'GET', defaults: { _controller: 'App\\\\Controller\\\\TaskController::index' } } }
        : args.includes('asset_mapper') ? { paths: { 'assets/': '' }, excluded_patterns: [], exclude_dotfiles: true, public_prefix: '/assets/' }
        : args.includes('debug:config') ? { stimulus: { controller_paths: [root + '/${controllers}'], controllers_json: root + '/assets/controllers.json' } }
        : args.includes('debug:container') ? { 'kernel.project_dir': root }
        : { loader_paths: { '(None)': ['templates'] }, functions: {}, filters: {} };
      setTimeout(() => process.stdout.write(JSON.stringify(answer)), ${delayMs});`, '--'];
    const CONTENT = ['debug:router', 'debug:twig', 'debug:twig-component'];
    const CONFIGURATION = ['debug:config asset_mapper', 'debug:config stimulus', 'debug:container'];
    const sorted = (entries: readonly string[]): string[] => [...entries].sort();
    try {
      await settings.update('console.enabled', true, vscode.ConfigurationTarget.Workspace);
      await settings.update('console.command', fakeConsole(0, 'assets/controllers'), vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
      const first = sessionsWithMemory();
      await first.initialize();
      const opened = rootSession(first);
      assert.ok(opened);
      assert.ok(opened.frontend.routes.some((route) => route.name === 'wicker_remembered'), 'the first opening asks the console');
      assert.equal(opened.consolePending, false);
      first.dispose();

      // Slow now, so the second opening is seen before the console answers.
      await settings.update('console.command', fakeConsole(1500, 'assets/controllers'), vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
      fs.rmSync(marker, { force: true });
      const second = sessionsWithMemory();
      initialized = second.initialize();
      await until(() => rootSession(second) !== undefined, 'the project should be published before the console answers');
      const reopened = rootSession(second)!;
      assert.equal(reopened.consolePending, true);
      assert.ok(reopened.frontend.routes.some((route) => route.name === 'wicker_remembered'), 'routes stand in from the last answer');
      assert.match(reopened.frontend.routesStatus, /earlier Symfony console answer/);
      assert.equal(reopened.loaderPaths.source, 'remembered');
      assert.equal(reopened.frontend.controllerDirectory, 'assets/controllers');
      assert.equal(reopened.discoveryCurrent, false, 'checks wait for the console');
      await initialized;
      assert.equal(reopened.consolePending, false);
      assert.match(reopened.frontend.routesStatus, /from Symfony console$/);
      assert.equal(reopened.loaderPaths.source, 'console');
      // What a person waits for first, then what memory answered, confirmed.
      const order = asked();
      assert.deepEqual(sorted(order.slice(0, 3)), CONTENT, order.join(', '));
      assert.deepEqual(sorted(order.slice(3)), CONFIGURATION, order.join(', '));
      second.dispose();

      // The Stimulus directory moved while the editor was closed: the
      // confirmation notices, and the pass is repeated with the console's answer.
      await settings.update('console.command', fakeConsole(0, 'assets/moved'), vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
      fs.rmSync(marker, { force: true });
      const third = sessionsWithMemory();
      await third.initialize();
      assert.equal(rootSession(third)?.frontend.controllerDirectory, 'assets/moved');
      const again = asked();
      assert.deepEqual(sorted(again.slice(0, 3)), CONTENT, again.join(', '));
      assert.deepEqual(sorted(again.slice(3, 6)), CONFIGURATION, again.join(', '));
      assert.deepEqual(sorted(again.slice(6)), CONTENT, again.join(', '));
      third.dispose();
    } finally {
      // A failed assertion above leaves an opening in flight, and its
      // sessions would keep answering the next test's console.
      await initialized?.catch(() => undefined);
      for (const sessions of owned) { sessions.dispose(); }
      fs.rmSync(marker, { force: true });
      await settings.update('console.command', previousCommand, vscode.ConfigurationTarget.Workspace);
      await settings.update('console.enabled', previousEnabled, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
    }
  });

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

  /*
   * Symfony rewrites its cache under var/ whenever the console boots, and the
   * editor's own watcher exclusions do not cover it, so every extension on
   * the machine was handed those events while Wicker indexed. The exclusion
   * is contributed as a default, which the editor merges with its own list
   * rather than replacing it.
   */
  test('excludes var/ from the file watcher without displacing the editor\'s own exclusions', () => {
    const excluded = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('watcherExclude') ?? {};
    assert.equal(excluded['**/var/**'], true);
    assert.equal(excluded['.git/objects/**'], true);
  });
});
