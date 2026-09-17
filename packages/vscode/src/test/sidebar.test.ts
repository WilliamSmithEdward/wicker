import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { TwigLoaderPaths } from '@wicker/core';

import type { WickerApi } from '../extension.js';
import { ConsoleMemory } from '../consoleMemory.js';
import { templatePicks } from '../pickers.js';
import { SessionManager, type ProjectSession } from '../session.js';
import { SIDEBAR_ICONS, sidebarIcon, type SidebarRole } from '../sidebarIcons.js';
import { isBundleNamespace, ProjectTreeProvider, type SidebarNode } from '../sidebar.js';
import { memorySessions, tooltipOf, until } from './support.js';

const ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');
const rootUri = vscode.Uri.file(ROOT);

async function openTemplate(...segments: string[]): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(rootUri, ...segments));
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}


async function section(tree: ProjectTreeProvider, project: SidebarNode | undefined, name: 'controllers' | 'templates'): Promise<SidebarNode> {
  assert.ok(project);
  const node = (await tree.getChildren(project)).find((child) => child.kind === 'section' && child.section === name);
  assert.ok(node);
  return node;
}

async function templateGroups(tree: ProjectTreeProvider, project: SidebarNode | undefined): Promise<SidebarNode[]> {
  return tree.getChildren(await section(tree, project, 'templates'));
}

suite('Wicker sidebar', () => {
  let sessions: SessionManager;
  let provider: ProjectTreeProvider;
  const remembered = new Map<string, unknown>();

  suiteSetup(async () => {
    await vscode.extensions.getExtension('WilliamSmithE.wicker')?.activate();
    await vscode.commands.executeCommand('wicker.hideBundleTemplates');
    // Exercise tree rows with real project sessions and the editor filesystem.
    // The registered view itself is tested through reveal/open commands below.
    sessions = new SessionManager(new ConsoleMemory({
      keys: () => [...remembered.keys()],
      get: <T>(key: string, fallback?: T): T | undefined => (remembered.get(key) as T | undefined) ?? fallback,
      update: (key: string, value: unknown) => { remembered.set(key, value); return Promise.resolve(); },
    }));
    await sessions.initialize();
    provider = new ProjectTreeProvider(sessions);
  });

  suiteTeardown(() => {
    provider?.dispose();
    sessions?.dispose();
  });

  test('groups each project by namespace and shows resolution source and real template targets', async () => {
    const roots = await provider.getChildren();
    assert.equal(roots.length, 2);
    const project = roots.find((node) => node.root.toString() === rootUri.toString());
    assert.ok(project);
    const children = await provider.getChildren(project);
    assert.ok((await Promise.all(children.map(async (node) => (await provider.getTreeItem(node)).label !== 'Namespaces'))).every(Boolean));
    assert.match(tooltipOf(await provider.getTreeItem(project)), /Namespaces: Configuration only/);
    const warning = children.find((node) => node.kind === 'warning' && node.reason === 'namespaces');
    assert.ok(warning);
    const warningItem = await provider.getTreeItem(warning);
    assert.equal(warningItem.label, 'Bundle namespaces unavailable');
    assert.equal(warningItem.command, undefined);
    assert.equal(warningItem.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.deepEqual(await Promise.all((await provider.getChildren(warning)).map(async (node) => (await provider.getTreeItem(node)).label)),
      ['Retry', 'Open console settings']);
    for (const action of await provider.getChildren(warning)) {
      assert.equal((await provider.getTreeItem(provider.getParent(action)!)).id, warningItem.id);
    }
    assert.deepEqual(await Promise.all(children.filter((node) => node.kind === 'section').map(async (node) => (await provider.getTreeItem(node)).label)),
      ['Controllers', 'Templates']);
    const groups = (await templateGroups(provider, project)).filter((node) => node.kind === 'namespace');
    assert.deepEqual(groups.map((node) => node.namespace), ['', '@Design']);
    const main = groups[0];
    const design = groups[1];
    assert.ok(main && design);
    assert.equal((await provider.getTreeItem(main)).label, 'Application');
    assert.equal((await provider.getTreeItem(design)).accessibilityInformation?.label, '@Design, 1');
    const namespaced = await provider.getChildren(design);
    assert.equal(namespaced.length, 1);
    const leaf = namespaced[0];
    assert.ok(leaf);
    const item = await provider.getTreeItem(leaf);
    assert.equal(item.label, 'badge.html.twig');
    assert.equal(item.resourceUri?.toString(), vscode.Uri.joinPath(rootUri, 'design/badge.html.twig').toString());
    assert.equal((await provider.getTreeItem(provider.getParent(leaf)!)).id, (await provider.getTreeItem(design)).id);
    const templates = await section(provider, project, 'templates');
    assert.equal((await provider.getTreeItem(provider.getParent(design)!)).id, (await provider.getTreeItem(templates)).id);
    assert.equal((await provider.getTreeItem(provider.getParent(templates)!)).id, (await provider.getTreeItem(project)).id);
    const application = await provider.getChildren(main);
    assert.deepEqual(await Promise.all(application.map(async (node) => (await provider.getTreeItem(node)).label)), ['components', 'task', 'base.html.twig']);
    const applicationLabels = await Promise.all(application.map(async (node) => (await provider.getTreeItem(node)).label));
    const task = application[applicationLabels.indexOf('task')];
    assert.ok(task);
    assert.equal((await provider.getTreeItem(task)).description, '2');
    // A folder and a namespace stand for their directory, so the git state of
    // the templates inside reaches them the way it reaches an Explorer folder.
    assert.equal((await provider.getTreeItem(task)).resourceUri?.toString(), vscode.Uri.joinPath(rootUri, 'templates/task').toString());
    assert.equal((await provider.getTreeItem(main)).resourceUri?.toString(), vscode.Uri.joinPath(rootUri, 'templates').toString());
    assert.equal((await provider.getTreeItem(project)).resourceUri?.toString(), rootUri.toString());
    const taskFiles = await provider.getChildren(task);
    assert.deepEqual(await Promise.all(taskFiles.map(async (node) => (await provider.getTreeItem(node)).label)), ['_row.html.twig', 'index.html.twig']);
    assert.ok(taskFiles.some((node) => node.kind === 'template' && node.name === 'task/index.html.twig'));
    assert.equal((await provider.getTreeItem(provider.getParent(taskFiles[0]!)!)).id, (await provider.getTreeItem(task)).id);
    assert.equal((await provider.getTreeItem(provider.getParent(task)!)).id, (await provider.getTreeItem(main)).id);
  });

  /*
   * The two directions a template cannot state about itself. It names what it
   * extends on its first line, and that name already navigates; nothing in it
   * names the controller that renders it or the pages built on it.
   */
  test('a template shows what renders it and what extends it', async () => {
    const project = (await provider.getChildren()).find((node) => node.root.toString() === rootUri.toString());
    const main = (await templateGroups(provider, project)).find((node) => node.kind === 'namespace' && node.namespace === '');
    assert.ok(main);
    const application = await provider.getChildren(main);
    const applicationLabels = await Promise.all(application.map(async (node) => (await provider.getTreeItem(node)).label));

    const task = application[applicationLabels.indexOf('task')];
    assert.ok(task);
    const page = (await provider.getChildren(task)).find((node) => node.kind === 'template' && node.name === 'task/index.html.twig');
    assert.ok(page);

    const rendered = (await provider.getChildren(page)).filter((node) => node.kind === 'renderedBy');
    assert.deepEqual(await Promise.all(rendered.map(async (node) => (await provider.getTreeItem(node)).label)),
      ['TaskController::index()']);
    const renderedItem = await provider.getTreeItem(rendered[0]!);
    assert.equal(renderedItem.description, 'Renders this');
    assert.deepEqual(provider.getParent(rendered[0]!), page);
    await vscode.commands.executeCommand(renderedItem.command!.command, ...renderedItem.command!.arguments!);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),
      vscode.Uri.joinPath(rootUri, 'src/Controller/TaskController.php').toString());

    // The layout is rendered by nothing and extended by the page above.
    const base = application[applicationLabels.indexOf('base.html.twig')];
    assert.ok(base);
    const baseChildren = await provider.getChildren(base);
    assert.deepEqual(baseChildren.filter((node) => node.kind === 'renderedBy'), []);
    const extended = baseChildren.find((node) => node.kind === 'extendedBy');
    assert.ok(extended, 'a layout should say which pages extend it');
    const extendedItem = await provider.getTreeItem(extended);
    assert.equal(extendedItem.label, 'Extended by');
    assert.equal(extendedItem.description, '1');
    const extending = await provider.getChildren(extended);
    assert.deepEqual(extending.map((node) => node.kind === 'extending' ? node.templateName : ''), ['task/index.html.twig']);
    assert.deepEqual(provider.getParent(extending[0]!), extended);
    assert.equal((await provider.getTreeItem(extending[0]!)).label, 'index.html.twig');

    // An included partial inherits nothing, so it carries no extends group.
    // It is still pulled in by a page, and that is the direction it cannot
    // state: nothing in a partial names the file that includes it.
    const row = (await provider.getChildren(task)).find((node) => node.kind === 'template' && node.name === 'task/_row.html.twig');
    assert.ok(row);
    const rowChildren = await provider.getChildren(row);
    assert.deepEqual(rowChildren.filter((node) => node.kind === 'extendedBy'), []);
    const included = rowChildren.find((node) => node.kind === 'includedBy');
    assert.ok(included, 'a partial should say which templates include it');
    const includedItem = await provider.getTreeItem(included);
    assert.equal(includedItem.label, 'Included by');
    assert.equal(includedItem.description, '1');
    assert.deepEqual(provider.getParent(included), row);
    const including = await provider.getChildren(included);
    assert.deepEqual(including.map((node) => node.kind === 'including' ? [node.projectPath, node.via] : []),
      [['templates/task/index.html.twig', 'include']]);
    const includingItem = await provider.getTreeItem(including[0]!);
    assert.equal(includingItem.label, 'index.html.twig');
    // The tag, not a guess: a reader has to be able to tell an include from an
    // embed or a macro import without opening the file.
    assert.equal(includingItem.description, 'Includes');
    assert.deepEqual(provider.getParent(including[0]!), included);
    await vscode.commands.executeCommand(includingItem.command!.command, ...includingItem.command!.arguments!);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),
      vscode.Uri.joinPath(rootUri, 'templates/task/index.html.twig').toString());

    // A layout is extended, never included, so it carries only the one group.
    assert.deepEqual(baseChildren.filter((node) => node.kind === 'includedBy'), []);
  });

  test('opens a namespaced template through the registered sidebar command', async () => {
    await vscode.commands.executeCommand('wicker.openTemplate', rootUri, '@Design/badge.html.twig');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),
      vscode.Uri.joinPath(rootUri, 'design/badge.html.twig').toString());
  });

  test('browses controller actions, opens current targets and keeps nested projects separate', async () => {
    const project = (await provider.getChildren()).find((node) => node.root.toString() === rootUri.toString());
    const controllers = await section(provider, project, 'controllers');
    const rows = await provider.getChildren(controllers);
    assert.deepEqual(await Promise.all(rows.map(async (node) => (await provider.getTreeItem(node)).label)), ['TaskController']);
    const controller = rows[0]!;
    assert.equal((await provider.getTreeItem(provider.getParent(controller)!)).id, (await provider.getTreeItem(controllers)).id);
    const controllerItem = await provider.getTreeItem(controller);
    assert.ok(controllerItem.command);
    await vscode.commands.executeCommand(controllerItem.command.command, ...controllerItem.command.arguments!);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),
      vscode.Uri.joinPath(rootUri, 'src/Controller/TaskController.php').toString());
    const actions = await provider.getChildren(controller);
    assert.deepEqual(await Promise.all(actions.map(async (node) => (await provider.getTreeItem(node)).label)), ['index()', 'missing()', 'badNamespace()']);
    for (const action of actions) {
      const leaf = (await provider.getChildren(action))[0]!;
      assert.ok(leaf.kind === 'controllerTemplate');
      assert.equal((await provider.getTreeItem(provider.getParent(action)!)).id, controllerItem.id);
      assert.equal((await provider.getTreeItem(provider.getParent(leaf)!)).id, (await provider.getTreeItem(action)).id);
      const command = (await provider.getTreeItem(action)).command!;
      await vscode.commands.executeCommand(command.command, ...command.arguments!);
      const editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
      assert.ok(editor);
      assert.equal(editor.document.getText(editor.selection), leaf.name);
      const item = await provider.getTreeItem(leaf);
      if (leaf.name === 'task/index.html.twig') {
        assert.ok(item.command);
        await vscode.commands.executeCommand(item.command.command, ...item.command.arguments!);
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),
          vscode.Uri.joinPath(rootUri, 'templates/task/index.html.twig').toString());
      } else {
        assert.equal(item.description, 'Unresolved');
        assert.equal(item.command, undefined);
      }
    }
    const nested = (await provider.getChildren()).find((node) => node.root.toString() === vscode.Uri.joinPath(rootUri, 'nested-app').toString());
    assert.deepEqual(await Promise.all((await provider.getChildren(await section(provider, nested, 'controllers'))).map(async (node) => (await provider.getTreeItem(node)).label)),
      ['NestedController']);
    // A forged parent-root node must not open a nested project's source.
    const before = vscode.window.activeTextEditor;
    await vscode.commands.executeCommand('wicker.openController', {
      kind: 'controller', root: rootUri, projectPath: 'nested-app/src/NestedController.php', className: 'NestedController',
    });
    assert.equal(vscode.window.activeTextEditor, before);
  });

  test('tracks unsaved controller edits, attributes and duplicate names without stale navigation', async () => {
    const php = await openTemplate('src', 'Controller', 'TaskController.php');
    const original = php.getText();
    const project = (await provider.getChildren()).find((node) => node.root.toString() === rootUri.toString());
    const controllers = await section(provider, project, 'controllers');
    const replace = async (source: string): Promise<void> => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(php.uri, new vscode.Range(php.positionAt(0), php.positionAt(php.getText().length)), source);
      assert.ok(await vscode.workspace.applyEdit(edit));
    };
    let changes = 0;
    const listener = provider.onDidChangeTreeData(() => { changes += 1; });
    const source = `<?php
      namespace App\\Controller {
        class PageController {
          function index() {
            $this->render('task/index.html.twig');
            $this->render('task/index.html.twig');
            $this->render('@Infrastructure/status.html.twig');
          }
          #[Template('task/_row.html.twig')]
          function attribute() {}
          function dynamic() { $this->render($name); }
        }
      }
      namespace Admin\\Controller { class PageController {
        function index() { $this->render('base.html.twig'); }
      } }
    `;
    try {
      await replace(source);
      const deadline = Date.now() + 5000;
      while (changes === 0) {
        assert.ok(Date.now() < deadline, 'PHP changes should refresh the sidebar');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const rows = await provider.getChildren(controllers);
      assert.equal(rows.length, 2);
      assert.notEqual((await provider.getTreeItem(rows[0]!)).id, (await provider.getTreeItem(rows[1]!)).id);
      const controller = rows.find((node) => node.kind === 'controller' && node.className === 'App\\Controller\\PageController')!;
      const actions = await provider.getChildren(controller);
      assert.deepEqual(await Promise.all(actions.map(async (node) => (await provider.getTreeItem(node)).label)), ['index()', 'attribute()']);
      const action = actions[0]!;
      const leaves = await provider.getChildren(action);
      assert.deepEqual(await Promise.all(leaves.map(async (node) => (await provider.getTreeItem(node)).label)),
        ['task/index.html.twig', '@Infrastructure/status.html.twig']);
      const item = await provider.getTreeItem(action);
      // Old nodes/commands should resolve fresh offsets after unrelated edits.
      await replace(source.replace('<?php', '<?php\n// shifted 💚\n'));
      assert.equal((await provider.getTreeItem(action)).id, item.id);
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      assert.equal(php.getText(vscode.window.activeTextEditor!.selection), 'task/index.html.twig');
      const attribute = await provider.getTreeItem(actions[1]!);
      await vscode.commands.executeCommand(attribute.command!.command, ...attribute.command!.arguments!);
      const editor = vscode.window.activeTextEditor!;
      assert.match(php.lineAt(editor.selection.start.line).text, /#\[Template/);
      assert.equal(php.getText(editor.selection), 'task/_row.html.twig');
      const bundle = await provider.getTreeItem(leaves[1]!);
      assert.ok(bundle.command, 'explicit render targets stay available when bundle browsing is hidden');
      await vscode.commands.executeCommand(bundle.command.command, ...bundle.command.arguments!);
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),
        vscode.Uri.joinPath(rootUri, 'vendor/sidebar-fixture/templates/status.html.twig').toString());
      await replace('<?php // controllers removed');
      assert.deepEqual(await provider.getChildren(controllers), []);
      assert.equal((await provider.getTreeItem(controller)).command, undefined);
      const before = vscode.window.activeTextEditor;
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      await vscode.commands.executeCommand(bundle.command.command, ...bundle.command.arguments!);
      assert.equal(vscode.window.activeTextEditor, before);
    } finally {
      listener.dispose();
      await replace(original);
      await vscode.window.showTextDocument(php);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    assert.deepEqual(await Promise.all((await provider.getChildren(controllers)).map(async (node) => (await provider.getTreeItem(node)).label)), ['TaskController']);
  });

  test('diagnostics from a project row describe only that project and reject stale roots', async () => {
    const nested = vscode.Uri.joinPath(rootUri, 'nested-app');
    const report = await vscode.commands.executeCommand<string>('wicker.showProjectInfo', { kind: 'project', root: nested });
    assert.ok(report?.startsWith('Symfony project\n\n'));
    assert.ok(report.includes('/nested-app\n'));
    assert.ok(!report.includes('/symfony-app\n'));
    assert.equal(await vscode.commands.executeCommand('wicker.showProjectInfo', {
      kind: 'project', root: vscode.Uri.joinPath(rootUri, '__removed_project'),
    }), undefined);
    await vscode.commands.executeCommand('workbench.action.closePanel');
  });

  /*
   * Routes, Stimulus controllers and components all come from the console.
   * When it cannot answer, those sections are simply absent, which reads as a
   * project that has none rather than as an answer nothing could give.
   */
  test('says so when the console cannot answer, rather than omitting its sections silently', async () => {
    const project = (await provider.getChildren()).find((node) => node.root.toString() === rootUri.toString());
    assert.ok(project);
    const warningFor = async (): Promise<SidebarNode | undefined> =>
      (await provider.getChildren(project)).find((child) => child.kind === 'warning' && child.reason === 'console');
    const settings = vscode.workspace.getConfiguration('wicker');
    const previousEnabled = settings.inspect<boolean>('console.enabled')?.workspaceValue;
    try {
      // The fixture has no PHP, so a console that is meant to run cannot.
      const warning = await warningFor();
      assert.ok(warning, 'a console that cannot answer should be reported');
      const item = await provider.getTreeItem(warning);
      assert.equal(item.label, 'Symfony console unavailable');
      const tooltip = tooltipOf(item);
      assert.match(tooltip, /Routes:/);
      assert.match(tooltip, /Stimulus:/);
      assert.match(tooltip, /wicker\.console\.command/);
      assert.deepEqual(await Promise.all((await provider.getChildren(warning)).map(async (node) =>
        (await provider.getTreeItem(node)).label)), ['Retry', 'Open console settings']);

      // Switching the console off is the user's own decision, and the
      // namespaces warning already explains it. Saying it twice is noise.
      await settings.update('console.enabled', false, vscode.ConfigurationTarget.Workspace);
      await sessions.refreshAll();
      assert.equal(await warningFor(), undefined);
    } finally {
      await settings.update('console.enabled', previousEnabled, vscode.ConfigurationTarget.Workspace);
      await sessions.refreshAll();
    }
  });

  test('warning actions recover console resolution and saved answers stay in the tooltip', async () => {
    const project = (await provider.getChildren()).find((node) => node.root.toString() === rootUri.toString());
    assert.ok(project);
    const settings = vscode.workspace.getConfiguration('wicker');
    const previousCommand = settings.inspect<string[]>('console.command')?.workspaceValue;
    const previousEnabled = settings.inspect<boolean>('console.enabled')?.workspaceValue;
    const node = process.env['npm_node_execpath'] ?? 'node';
    // A deterministic console process: real execFile and session refresh, no PHP required.
    const answer = JSON.stringify({ loader_paths: { '(None)': ['templates'] } });
    try {
      await settings.update('console.enabled', false, vscode.ConfigurationTarget.Workspace);
      await sessions.refreshAll();
      const warning = (await provider.getChildren(project)).find((child) => child.kind === 'warning' && child.reason === 'namespaces');
      assert.ok(warning);
      const retry = (await provider.getChildren(warning)).find((child) => child.kind === 'action' && child.action === 'retry');
      assert.ok(retry);
      const command = (await provider.getTreeItem(retry)).command;
      assert.ok(command);
      assert.equal(await vscode.commands.executeCommand(command.command, ...command.arguments!), true);
      const limitedReport = await vscode.commands.executeCommand<string>('wicker.showProjectInfo', project);
      assert.ok(limitedReport?.includes('read from      config/packages/twig.yaml'));

      await settings.update('console.command', [node, '-e', `process.stdout.write(${JSON.stringify(answer)})`, '--'], vscode.ConfigurationTarget.Workspace);
      // Let the refresh for this setting finish before changing the next one.
      await vscode.commands.executeCommand('wicker.reindex');
      await settings.update('console.enabled', true, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
      await sessions.refreshAll();
      assert.match(tooltipOf(await provider.getTreeItem(project)), /Namespaces: Symfony console/);
      assert.ok(!(await provider.getChildren(project)).some((child) => child.kind === 'warning' && child.reason === 'namespaces'));
      assert.deepEqual(await provider.getChildren(warning), []);
      assert.equal((await provider.getTreeItem(retry)).command, undefined);
      assert.equal(await vscode.commands.executeCommand(command.command, ...command.arguments!), false);

      await settings.update('console.command', [node, '-e', 'process.exit(1)', '--'], vscode.ConfigurationTarget.Workspace);
      await sessions.refreshAll();
      assert.match(tooltipOf(await provider.getTreeItem(project)), /Namespaces: Saved from Symfony/);
      assert.ok(!(await provider.getChildren(project)).some((child) => child.kind === 'warning' && child.reason === 'namespaces'));
      await vscode.commands.executeCommand('workbench.action.closePanel');
    } finally {
      await settings.update('console.command', previousCommand, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
      await settings.update('console.enabled', previousEnabled, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
      remembered.clear();
      await sessions.refreshAll();
    }
  });

  test('index truncation has a distinct warning with relevant settings and stable identities', async () => {
    const project = (await provider.getChildren()).find((node) => node.root.toString() === rootUri.toString());
    assert.ok(project);
    const settings = vscode.workspace.getConfiguration('wicker');
    const previousLimit = settings.inspect<number>('index.maxFiles')?.workspaceValue;
    try {
      await settings.update('index.maxFiles', 1, vscode.ConfigurationTarget.Workspace);
      await sessions.refreshAll();
      const warning = (await provider.getChildren(project)).find((node) => node.kind === 'warning' && node.reason === 'indexLimit');
      assert.ok(warning);
      assert.equal((await provider.getTreeItem(warning)).label, 'Template index limit reached');
      const actions = await provider.getChildren(warning);
      assert.deepEqual(await Promise.all(actions.map(async (node) => (await provider.getTreeItem(node)).label)), ['Retry', 'Open index settings']);
      assert.notEqual((await provider.getTreeItem(actions[0]!)).id, (await provider.getTreeItem(actions[1]!)).id);
    } finally {
      await settings.update('index.maxFiles', previousLimit, vscode.ConfigurationTarget.Workspace);
      await sessions.refreshAll();
    }
    assert.ok((await provider.getChildren(project)).every((node) => node.kind !== 'warning' || node.reason !== 'indexLimit'));
  });

  test('identifies bundle namespaces without hiding application namespaces or overrides', () => {
    const entries = TwigLoaderPaths.fromEntries([
      { namespace: null, forcesBundleTemplate: false, directories: ['templates'] },
      { namespace: 'Design', forcesBundleTemplate: false, directories: ['design'] },
      { namespace: 'VendorTools', forcesBundleTemplate: false, directories: ['vendor-tools'] },
      { namespace: 'Library', forcesBundleTemplate: false, directories: ['vendor/acme/templates'] },
      { namespace: 'Framework', forcesBundleTemplate: false, directories: ['templates/bundles/FrameworkBundle'] },
      { namespace: 'Framework', forcesBundleTemplate: true, directories: ['dependencies/framework/templates'] },
    ]).all();
    assert.equal(isBundleNamespace(entries, ''), false);
    assert.equal(isBundleNamespace(entries, '@Design'), false);
    assert.equal(isBundleNamespace(entries, '@VendorTools'), false);
    assert.equal(isBundleNamespace(entries, '@Library'), true);
    assert.equal(isBundleNamespace(entries, '@Framework'), true);
    assert.equal(isBundleNamespace(entries, '@!Framework'), true);
  });

  test('shows bundles on request, keeps them indexed while hidden and reveals an open bundle file', async () => {
    const project = (await provider.getChildren()).find((node) => node.root.toString() === rootUri.toString());
    assert.ok(project);
    const groups = async () => (await templateGroups(provider, project))
      .filter((node) => node.kind === 'namespace').map((node) => node.namespace);
    assert.deepEqual(await groups(), ['', '@Design']);
    assert.equal((await provider.getTreeItem(await section(provider, project, 'templates'))).description, '6');
    assert.ok(sessions.sessionFor({ uri: rootUri })?.lookup('@Infrastructure/status.html.twig'));
    let changes = 0;
    const listener = provider.onDidChangeTreeData(() => { changes += 1; });
    try {
      const beforeShow = changes;
      provider.setShowBundleTemplates(true);
      assert.equal(changes, beforeShow + 1);
      await vscode.commands.executeCommand('wicker.showBundleTemplates');
      assert.deepEqual(await groups(), ['', '@Design', '@Infrastructure']);
      assert.equal((await provider.getTreeItem(await section(provider, project, 'templates'))).description, '7');
      const bundle = (await templateGroups(provider, project)).find((node) => node.kind === 'namespace' && node.namespace === '@Infrastructure');
      assert.ok(bundle);
      assert.equal((await provider.getChildren(bundle)).length, 1);
      const beforeHide = changes;
      provider.setShowBundleTemplates(false);
      assert.equal(changes, beforeHide + 1);
      await vscode.commands.executeCommand('wicker.hideBundleTemplates');
      assert.deepEqual(await provider.getChildren(bundle), []);
      assert.deepEqual(await groups(), ['', '@Design']);
      await vscode.commands.executeCommand('wicker.openTemplate', rootUri, '@Infrastructure/status.html.twig');
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),
        vscode.Uri.joinPath(rootUri, 'vendor/sidebar-fixture/templates/status.html.twig').toString());
      assert.equal(await vscode.commands.executeCommand('wicker.revealTemplate'), true);
      // A provider restored with the saved "show" preference includes bundles immediately.
      const restored = new ProjectTreeProvider(sessions, true);
      try {
        assert.ok((await templateGroups(restored, project)).some((node) => node.kind === 'namespace' && node.namespace === '@Infrastructure'));
      } finally {
        restored.dispose();
      }
    } finally {
      listener.dispose();
      provider.setShowBundleTemplates(false);
      await vscode.commands.executeCommand('wicker.hideBundleTemplates');
    }
  });

  test('reveals main, namespaced and nested-project templates in the registered native tree', async () => {
    for (const segments of [
      ['templates', 'task', 'index.html.twig'],
      ['design', 'badge.html.twig'],
      ['nested-app', 'templates', 'task', '_row.html.twig'],
    ]) {
      await openTemplate(...segments);
      assert.equal(await vscode.commands.executeCommand('wicker.revealTemplate'), true);
    }
    await openTemplate('src', 'Controller', 'TaskController.php');
    assert.equal(await vscode.commands.executeCommand('wicker.revealTemplate'), false);
  });

  test('refreshes when templates are added and removed', async () => {
    const uri = vscode.Uri.joinPath(rootUri, 'templates', 'sidebar-test.html.twig');
    let changes = 0;
    const listener = provider.onDidChangeTreeData(() => { changes += 1; });
    const includesNewFile = async (): Promise<boolean> => {
      const root = (await provider.getChildren()).find((node) => node.root.toString() === rootUri.toString());
      const main = (await templateGroups(provider, root)).find((node) => node.kind === 'namespace' && node.namespace === '');
      return (await provider.getChildren(main)).some((node) => node.kind === 'template' && node.name === 'sidebar-test.html.twig');
    };
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from('Sidebar test'));
      await sessions.refreshAll();
      assert.ok(await includesNewFile());
      assert.ok(changes > 0);
    } finally {
      listener.dispose();
      await vscode.workspace.fs.delete(uri);
      await sessions.refreshAll();
    }
    assert.ok(!await includesNewFile());
  });

  /*
   * A controller added to a project has to appear without a reload. The list
   * of controllers is derived from the whole PHP index and held until the
   * index changes, so a change that did not say so would leave the tree
   * showing the project as it was when it was opened.
   */
  test('lists a controller created on disk, and drops it again when it goes', async () => {
    const file = vscode.Uri.joinPath(rootUri, 'src/Controller/SidebarCreatedController.php');
    const listed = async (): Promise<boolean> => {
      const project = (await provider.getChildren()).find((node) => node.root.toString() === rootUri.toString());
      const rows = await provider.getChildren(await section(provider, project, 'controllers'));
      return rows.some((node) => node.kind === 'controller' && node.className.endsWith('SidebarCreatedController'));
    };
    // Without a rebuild: a created file is read on its own, so this is the
    // path a stale derived list would survive a full refresh and still fail.
    const eventually = async (want: boolean, message: string): Promise<void> => {
      const deadline = Date.now() + 10000;
      while (await listed() !== want) {
        assert.ok(Date.now() < deadline, message);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    assert.ok(!await listed());
    try {
      await vscode.workspace.fs.writeFile(file, Buffer.from(`<?php namespace App\\Controller;
class SidebarCreatedController {
  public function index() { return $this->render('task/index.html.twig'); }
}`));
      await eventually(true, 'a controller created on disk should appear in the tree');
    } finally {
      await vscode.workspace.fs.delete(file);
    }
    await eventually(false, 'a deleted controller should leave the tree');
  });

  test('reveals deeply nested folders, keeps namespaces separate and removes empty folders', async () => {
    const directories = [
      vscode.Uri.joinPath(rootUri, 'templates', '__sidebar_tree_test'),
      vscode.Uri.joinPath(rootUri, 'design', '__sidebar_tree_test'),
      vscode.Uri.joinPath(rootUri, 'templates', '__sidebar_tree_test_extra'),
    ];
    const findFolder = async (namespace: string): Promise<SidebarNode | undefined> => {
      const root = (await provider.getChildren()).find((node) => node.root.toString() === rootUri.toString());
      assert.ok(root);
      const group = (await templateGroups(provider, root)).find((node) => node.kind === 'namespace' && node.namespace === namespace);
      assert.ok(group);
      return (await provider.getChildren(group)).find((node) => node.kind === 'folder' && node.path === '__sidebar_tree_test');
    };
    try {
      for (const directory of directories) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(directory, 'partials'));
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, 'partials/card.html.twig'), Buffer.from('Card'));
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, 'index.html.twig'), Buffer.from('Index'));
      }
      await sessions.refreshAll();
      await vscode.commands.executeCommand('wicker.reindex');
      const main = await findFolder('');
      const design = await findFolder('@Design');
      assert.ok(main && design);
      assert.notEqual((await provider.getTreeItem(main)).id, (await provider.getTreeItem(design)).id);
      for (const folder of [main, design]) {
        assert.equal((await provider.getTreeItem(folder)).description, '2');
        const children = await provider.getChildren(folder);
        assert.deepEqual(await Promise.all(children.map(async (node) => (await provider.getTreeItem(node)).label)), ['partials', 'index.html.twig']);
        const partials = children[0]!;
        const card = (await provider.getChildren(partials))[0]!;
        const item = await provider.getTreeItem(card);
        assert.equal(item.label, 'card.html.twig');
        assert.equal((await provider.getTreeItem(provider.getParent(card)!)).id, (await provider.getTreeItem(partials)).id);
        assert.equal((await provider.getTreeItem(provider.getParent(partials)!)).id, (await provider.getTreeItem(folder)).id);
        assert.ok(item.command && item.resourceUri);
        await vscode.commands.executeCommand(item.command.command, ...item.command.arguments!);
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), item.resourceUri.toString());
        assert.equal(await vscode.commands.executeCommand('wicker.revealTemplate'), true);
        assert.equal((await provider.getTreeItem(card)).tooltip,
          `${folder === main ? '' : '@Design/'}__sidebar_tree_test/partials/card.html.twig\n${folder === main ? 'templates' : 'design'}/__sidebar_tree_test/partials/card.html.twig`);
      }
    } finally {
      for (const directory of directories) {
        // These are the exact fixture directories created above, never a project root.
        await vscode.workspace.fs.delete(directory, { recursive: true });
      }
      await sessions.refreshAll();
      await vscode.commands.executeCommand('wicker.reindex');
    }
    assert.equal(await findFolder(''), undefined);
    assert.equal(await findFolder('@Design'), undefined);
  });

  test('clears disabled projects and rejects stale open/reveal actions until enabled again', async () => {
    await openTemplate('templates', 'task', 'index.html.twig');
    const before = vscode.window.activeTextEditor?.document.uri.toString();
    const project = (await provider.getChildren())[0];
    assert.ok(project);
    const settings = vscode.workspace.getConfiguration('wicker');
    await settings.update('enable', false, vscode.ConfigurationTarget.Workspace);
    try {
      assert.deepEqual(await provider.getChildren(), []);
      assert.deepEqual(await provider.getChildren(project), []);
      assert.equal(await vscode.commands.executeCommand('wicker.retryProject', {
        kind: 'action', root: project.root, reason: 'namespaces', action: 'retry',
      }), false);
      assert.equal(await vscode.commands.executeCommand('wicker.showProjectInfo', project), undefined);
      assert.equal(await vscode.commands.executeCommand('wicker.revealTemplate'), false);
      await vscode.commands.executeCommand('wicker.openTemplate', rootUri, '@Design/badge.html.twig');
      await vscode.commands.executeCommand('wicker.openController', {
        kind: 'controllerMethod', root: rootUri, projectPath: 'src/Controller/TaskController.php',
        className: 'App\\Controller\\TaskController', methodName: 'index',
      });
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), before);
    } finally {
      await settings.update('enable', undefined, vscode.ConfigurationTarget.Workspace);
    }
    assert.equal((await provider.getChildren()).length, 2);
    assert.equal(await vscode.commands.executeCommand('wicker.revealTemplate'), true);
  });

  test('every sidebar icon resolves to something that will actually draw', () => {
    // ThemeIcon accepts any string and renders nothing when the id is wrong,
    // and a missing SVG fails the same silent way. A typo is therefore
    // invisible until someone happens to look at that row, so the ids are
    // checked against the codicon list of the editor running the test.
    const stylesheet = [
      path.join(vscode.env.appRoot, 'extensions', 'simple-browser', 'media', 'codicon.css'),
      path.join(vscode.env.appRoot, 'extensions', 'mermaid-markdown-features', 'chat-webview-out', 'codicon.css'),
    ].find((file) => fs.existsSync(file));
    assert.ok(stylesheet, `no codicon.css found under ${vscode.env.appRoot}; this locator needs updating`);

    const codicons = new Set((fs.readFileSync(stylesheet, 'utf8').match(/codicon-[a-z0-9-]+/g) ?? [])
      .map((name) => name.slice('codicon-'.length)));
    assert.ok(codicons.size > 100, 'the codicon list should have parsed');

    // The two roles drawn as inline SVG rather than from the codicon font.
    const drawn = new Set(['template-leaf', 'route-leaf']);

    const broken = Object.entries(SIDEBAR_ICONS).flatMap(([role, { id }]) => {
      // A modifier such as ~spin is the workbench's animation, not a glyph.
      const name = id.replace(/~\w+$/, '');
      if (!drawn.has(id)) { return codicons.has(name) ? [] : [`${role}: no codicon "${id}"`]; }
      const icon = sidebarIcon(role as SidebarRole);
      if (!('dark' in icon)) { return [`${role}: "${id}" should be drawn, not a ThemeIcon`]; }
      return [icon.light, icon.dark]
        // skipEncoding, matching how the workbench serialises an icon into CSS.
        .filter((uri) => !/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/.test(uri.toString(true)))
        .map((uri) => `${role}: "${id}" is not an inline SVG: ${uri.toString(true).slice(0, 48)}`);
    });
    assert.deepEqual(broken, []);
  });

  test('wicker.sidebar.colors off draws every icon but a warning in the plain icon colour', async () => {
    // A codicon takes a theme colour and a drawn leaf carries its stroke
    // inline, so both must follow the setting, and the tree must redraw when
    // it changes or the old colours stay on screen. Off states the plain
    // colour rather than omitting one: the workbench colours a symbol-*
    // codicon from its own palette whenever nothing is stated.
    const codiconColour = (role: SidebarRole): vscode.ThemeColor | undefined => {
      const icon = sidebarIcon(role);
      assert.ok(!('dark' in icon), `${role} should be a ThemeIcon`);
      return icon.color;
    };
    const leafStroke = (role: SidebarRole): string | undefined => {
      const icon = sidebarIcon(role);
      assert.ok('dark' in icon, `${role} should be drawn`);
      const svg = Buffer.from(icon.dark.toString(true).split(',')[1] ?? '', 'base64').toString('utf8');
      return /stroke="(#[0-9a-f]{6})"/.exec(svg)?.[1];
    };
    assert.equal(codiconColour('controller')?.id, 'charts.purple');
    assert.equal(leafStroke('template'), '#89d185');

    const settings = vscode.workspace.getConfiguration('wicker');
    const previous = settings.inspect<boolean>('sidebar.colors')?.workspaceValue;
    let changes = 0;
    const listener = provider.onDidChangeTreeData(() => { changes += 1; });
    try {
      await settings.update('sidebar.colors', false, vscode.ConfigurationTarget.Workspace);
      await until(() => changes > 0, 'the tree should redraw when colours are turned off');
      assert.equal(codiconColour('controller')?.id, 'icon.foreground');
      assert.equal(codiconColour('warning')?.id, 'list.warningForeground');
      assert.equal(leafStroke('template'), '#c5c5c5');
      assert.equal(leafStroke('templateRoute'), '#c5c5c5');
    } finally {
      listener.dispose();
      await settings.update('sidebar.colors', previous, vscode.ConfigurationTarget.Workspace);
    }
    assert.equal(codiconColour('controller')?.id, 'charts.purple');
  });

  test('follows the active editor, as the Explorer follows its file', async () => {
    const api = await vscode.extensions.getExtension('WilliamSmithE.wicker')!.activate() as WickerApi;
    const selected = (): string[] => api.sidebar.selection.map((node) => node.kind === 'template' ? node.name : node.kind);
    // Following happens only while the view is showing.
    await vscode.commands.executeCommand('wicker.projects.focus');
    await openTemplate('templates', 'task', 'index.html.twig');
    await until(() => selected().includes('task/index.html.twig'), 'the sidebar should select the active template');
    // A PHP editor is nothing to follow; the template stays selected.
    await openTemplate('src', 'Controller', 'TaskController.php');
    assert.ok(selected().includes('task/index.html.twig'));

    const settings = vscode.workspace.getConfiguration('wicker');
    const previous = settings.inspect<boolean>('sidebar.autoReveal')?.workspaceValue;
    try {
      await settings.update('sidebar.autoReveal', false, vscode.ConfigurationTarget.Workspace);
      await openTemplate('templates', 'task', '_row.html.twig');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(!selected().includes('task/_row.html.twig'), 'off leaves the selection alone');
    } finally {
      await settings.update('sidebar.autoReveal', previous, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('a row opens to the side and copies the name it stands for', async () => {
    const template: SidebarNode = { kind: 'template', root: rootUri, name: 'task/index.html.twig' };
    const before = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    await vscode.commands.executeCommand('wicker.openToSide', template);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor && editor.document.uri.path.endsWith('/templates/task/index.html.twig'));
    assert.equal(editor.viewColumn, before + 1);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    await vscode.commands.executeCommand('wicker.copyTemplateName', template);
    assert.equal(await vscode.env.clipboard.readText(), 'task/index.html.twig');
    await vscode.commands.executeCommand('wicker.copyControllerName', { kind: 'stimulusController', root: rootUri, name: 'wicker-test' });
    assert.equal(await vscode.env.clipboard.readText(), 'wicker-test');

    // The template picker answers to logical names, the application's own
    // before any namespace, and says where each one lives.
    const picks = templatePicks(sessions);
    const index = picks.find((pick) => pick.label === 'task/index.html.twig');
    assert.ok(index);
    assert.ok(index.description?.startsWith('templates/task/index.html.twig'), index.description);
    assert.ok(picks.some((pick) => pick.label === '@Design/badge.html.twig'));
    const firstNamespaced = picks.findIndex((pick) => pick.label.startsWith('@'));
    assert.ok(firstNamespaced > 0 && picks.slice(0, firstNamespaced).every((pick) => !pick.label.startsWith('@')));

    // The menu reads the context value: a row that opens a file says so, and
    // a section, which opens nothing, does not.
    assert.match((await provider.getTreeItem(template)).contextValue ?? '', /^wicker\.template\b.*\bopens\b.*\bfile\b/);
    const project = (await provider.getChildren())[0];
    assert.ok(project);
    const templates = await section(provider, project, 'templates');
    assert.doesNotMatch((await provider.getTreeItem(templates)).contextValue ?? '', /\bopens\b/);
  });

  /*
   * Six kernel boots on a container or a remote machine take longer than
   * reading the project, and the tree used to wait for them with nothing to
   * show. It is drawn from the files first and says it is waiting, rather
   * than warning about a console it has not heard from yet.
   */
  test('draws the project before the console answers, with a row saying so', async () => {
    const settings = vscode.workspace.getConfiguration('wicker');
    const previousCommand = settings.inspect<string[]>('console.command')?.workspaceValue;
    const previousEnabled = settings.inspect<boolean>('console.enabled')?.workspaceValue;
    const node = process.env['npm_node_execpath'] ?? 'node';
    const answer = JSON.stringify({ loader_paths: { '(None)': ['templates'] } });
    const own = memorySessions();
    const tree = new ProjectTreeProvider(own);
    const published = (): ProjectSession | undefined => own.all()
      .find((candidate) => candidate.fileSystem.toUri(candidate.project.root).toString() === rootUri.toString());
    try {
      await settings.update('console.enabled', true, vscode.ConfigurationTarget.Workspace);
      await settings.update('console.command', [node, '-e',
        `setTimeout(() => process.stdout.write(${JSON.stringify(answer)}), 300)`, '--'], vscode.ConfigurationTarget.Workspace);
      // The half of initialize() that is worth waiting for: no console is asked.
      await own.publishAll();
      const session = published();
      assert.ok(session);
      assert.equal(session.consolePending, true);
      // Every folder is drawn before any console is asked: a second project
      // used to wait for the first project's console.
      assert.equal(own.all().length, 2);
      assert.ok(own.all().every((candidate) => candidate.consolePending));
      const project = (await tree.getChildren()).find((child) => child.root.toString() === rootUri.toString());
      assert.ok(project);
      const children = await tree.getChildren(project);
      assert.equal(children[0]?.kind, 'pending');
      assert.ok(!children.some((child) => child.kind === 'warning'), 'nothing is unavailable until the console has answered');
      const item = await tree.getTreeItem(children[0]);
      assert.equal(item.label, 'Asking the Symfony console...');
      assert.match(tooltipOf(item), /has not answered yet/);
      assert.match(tooltipOf(await tree.getTreeItem(project)), /waiting for the Symfony console/);

      await own.askAll();
      assert.equal(session.consolePending, false);
      assert.equal(session.loaderPaths.source, 'console');
      assert.ok(!(await tree.getChildren(project)).some((child) => child.kind === 'pending'));
      // How long the console took is there to be read off, not described.
      assert.match(tooltipOf(await tree.getTreeItem(project)), /Slowest console answer: debug:[a-z:-]+( [a-z_]+)*, \d+\.\d s/);
    } finally {
      tree.dispose();
      own.dispose();
      await settings.update('console.command', previousCommand, vscode.ConfigurationTarget.Workspace);
      await settings.update('console.enabled', previousEnabled, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
    }
  });

  /*
   * A controller answering only JSON renders nothing, so no render site finds
   * it. It had no row at all, while a JSON action did appear under any
   * controller that also rendered a page, and a row that was there opened
   * nothing because there was no render call to open.
   */
  test('lists a controller whose actions only answer JSON, and opens them', async () => {
    const settings = vscode.workspace.getConfiguration('wicker');
    const previousCommand = settings.inspect<string[]>('console.command')?.workspaceValue;
    const previousEnabled = settings.inspect<boolean>('console.enabled')?.workspaceValue;
    const php = vscode.Uri.joinPath(rootUri, 'src/Controller/WickerJsonOnlyController.php');
    const routes = { wicker_json_only: { path: '/api/v1/wicker/only', method: 'GET',
      defaults: { _controller: 'App\\Controller\\WickerJsonOnlyController::list' } } };
    const fake = `process.stdout.write(JSON.stringify(process.argv.includes('debug:router') ? ${JSON.stringify(routes)} : { loader_paths: { '(None)': ['templates'] } }));`;
    const own = memorySessions();
    const tree = new ProjectTreeProvider(own);
    try {
      await vscode.workspace.fs.writeFile(php, Buffer.from(
        "<?php namespace App\\Controller;\nclass WickerJsonOnlyController {\n  public function list() { return $this->json(['items' => []]); }\n}\n"));
      await settings.update('console.enabled', true, vscode.ConfigurationTarget.Workspace);
      await settings.update('console.command', [process.env['npm_node_execpath'] ?? 'node', '-e', fake, '--'], vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
      await own.initialize();

      const project = (await tree.getChildren()).find((child) => child.root.toString() === rootUri.toString());
      const controllers = await tree.getChildren(await section(tree, project, 'controllers'));
      const only = controllers.find((child) => child.kind === 'controller' && child.className === 'App\\Controller\\WickerJsonOnlyController');
      assert.ok(only, 'a controller that renders nothing still has a row');
      const row = await tree.getTreeItem(only);
      assert.equal(row.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      assert.equal(row.description, '1');
      assert.equal(row.command?.command, 'wicker.openController');

      const actions = await tree.getChildren(only);
      assert.equal(actions.length, 1);
      const action = await tree.getTreeItem(actions[0]!);
      assert.match(typeof action.label === 'string' ? action.label : action.label?.label ?? '', /\/api\/v1\/wicker\/only/);
      assert.equal(action.collapsibleState, vscode.TreeItemCollapsibleState.None);
      assert.ok(action.command, 'an action that renders nothing opens where it is declared');
      await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
      const editor = vscode.window.activeTextEditor;
      assert.equal(editor?.document.uri.toString(), php.toString());
      assert.match(editor?.document.lineAt(editor.selection.start.line).text ?? '', /function list\(\)/);
    } finally {
      tree.dispose();
      own.dispose();
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      try { await vscode.workspace.fs.delete(php); } catch { /* never written */ }
      await settings.update('console.command', previousCommand, vscode.ConfigurationTarget.Workspace);
      await settings.update('console.enabled', previousEnabled, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
    }
  });

  /*
   * A flat list of endpoints is a wall of /api/v1/... prefixes that differ
   * only at the end. Grouped by path, the prefix is read once and each row is
   * named by where it ends; the setting gives the flat list back.
   */
  test('groups the route sections by path, and lists them flat when asked', async () => {
    const settings = vscode.workspace.getConfiguration('wicker');
    const previousCommand = settings.inspect<string[]>('console.command')?.workspaceValue;
    const previousEnabled = settings.inspect<boolean>('console.enabled')?.workspaceValue;
    const previousHierarchy = settings.inspect<boolean>('sidebar.routeHierarchy')?.workspaceValue;
    const php = vscode.Uri.joinPath(rootUri, 'src/Controller/WickerApiTreeController.php');
    const controller = 'App\\Controller\\WickerApiTreeController';
    const routes = {
      wicker_tree_health: { path: '/api/health', method: 'GET', defaults: { _controller: `${controller}::health` } },
      wicker_tree_items: { path: '/api/v1/items', method: 'GET', defaults: { _controller: `${controller}::items` } },
      wicker_tree_item: { path: '/api/v1/items/{id}', method: 'GET', defaults: { _controller: `${controller}::item` } },
      wicker_tree_page: { path: '/admin/reports/monthly', method: 'GET', defaults: { _controller: `${controller}::page` } },
    };
    const fake = `process.stdout.write(JSON.stringify(process.argv.includes('debug:router') ? ${JSON.stringify(routes)} : { loader_paths: { '(None)': ['templates'] } }));`;
    const own = memorySessions();
    const tree = new ProjectTreeProvider(own);
    const labelOf = (item: vscode.TreeItem): string => typeof item.label === 'string' ? item.label : item.label?.label ?? '';
    const rows = async (node: SidebarNode): Promise<string[]> => Promise.all((await tree.getChildren(node)).map(async (child) => {
      const item = await tree.getTreeItem(child);
      return child.kind === 'routeFolder' ? `${labelOf(item)}/ ${String(item.description)}` : labelOf(item);
    }));
    const folder = async (node: SidebarNode, name: string): Promise<SidebarNode> => {
      const found = (await tree.getChildren(node)).find((child) => child.kind === 'routeFolder' && child.path.split('/').at(-1) === name);
      assert.ok(found, `a ${name} folder`);
      return found;
    };
    try {
      await vscode.workspace.fs.writeFile(php, Buffer.from([
        '<?php namespace App\\Controller;', 'class WickerApiTreeController {',
        "  public function health() { return $this->json(['ok' => true]); }",
        "  public function items() { return $this->json(['items' => []]); }",
        "  public function item() { return $this->json(['item' => null]); }",
        "  public function page() { return $this->render('task/index.html.twig'); }", '}', ''].join('\n')));
      await settings.update('console.enabled', true, vscode.ConfigurationTarget.Workspace);
      await settings.update('console.command', [process.env['npm_node_execpath'] ?? 'node', '-e', fake, '--'], vscode.ConfigurationTarget.Workspace);
      await own.initialize();
      const project = (await tree.getChildren()).find((child) => child.root.toString() === rootUri.toString());
      assert.ok(project);
      const api = (await tree.getChildren(project)).find((child) => child.kind === 'section' && child.section === 'api');
      assert.ok(api, 'the API routes section');

      // api > v1 > items > {id}, each folder counting what lies beneath it and
      // a route sitting beside the folder of the routes beneath it.
      assert.deepEqual(await rows(api), ['api/ 3']);
      const top = await folder(api, 'api');
      assert.deepEqual(await rows(top), ['v1/ 2', 'GET health']);
      const v1 = await folder(top, 'v1');
      assert.deepEqual(await rows(v1), ['items/ 1', 'GET items']);
      const items = await folder(v1, 'items');
      assert.deepEqual(await rows(items), ['GET {id}']);
      const [leaf] = await tree.getChildren(items);
      assert.ok(leaf);
      assert.match(tooltipOf(await tree.getTreeItem(leaf)), /GET \/api\/v1\/items\/\{id\}/);
      // The way back up, which is what reveal walks.
      assert.deepEqual(tree.getParent(leaf), items);
      assert.deepEqual(tree.getParent(items), v1);
      assert.deepEqual(tree.getParent(top), api);

      // Template routes group the same way, under the same setting, and their
      // folders keep the section's own colour rather than the API hue.
      const templates = (await tree.getChildren(project)).find((child) => child.kind === 'section' && child.section === 'templateRoutes');
      assert.ok(templates, 'the template routes section');
      assert.deepEqual(await rows(templates), ['admin/ 1']);
      const admin = await folder(templates, 'admin');
      assert.deepEqual(await rows(admin), ['reports/ 1']);
      const reports = await folder(admin, 'reports');
      assert.deepEqual(await rows(reports), ['GET monthly']);
      assert.equal(((await tree.getTreeItem(admin)).iconPath as vscode.ThemeIcon).color?.id, 'terminal.ansiBrightGreen');
      assert.equal(((await tree.getTreeItem(top)).iconPath as vscode.ThemeIcon).color?.id, 'terminal.ansiCyan');
      const [page] = await tree.getChildren(reports);
      assert.ok(page);
      assert.deepEqual(tree.getParent(page), reports);
      assert.deepEqual(tree.getParent(reports), admin);
      assert.deepEqual(tree.getParent(admin), templates);

      await settings.update('sidebar.routeHierarchy', false, vscode.ConfigurationTarget.Workspace);
      assert.deepEqual(await rows(api), ['GET /api/health', 'GET /api/v1/items', 'GET /api/v1/items/{id}']);
      assert.deepEqual(await rows(templates), ['GET /admin/reports/monthly']);
      const [flat] = await tree.getChildren(api);
      assert.ok(flat);
      assert.deepEqual(tree.getParent(flat), api);
    } finally {
      tree.dispose();
      own.dispose();
      try { await vscode.workspace.fs.delete(php); } catch { /* never written */ }
      await settings.update('sidebar.routeHierarchy', previousHierarchy, vscode.ConfigurationTarget.Workspace);
      await settings.update('console.command', previousCommand, vscode.ConfigurationTarget.Workspace);
      await settings.update('console.enabled', previousEnabled, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
    }
  });

  test('has an empty tree when no Symfony project is detected', async () => {
    const empty = new SessionManager(new ConsoleMemory({
      keys: () => [], get: <T>(_key: string, fallback?: T): T | undefined => fallback,
      update: () => Promise.resolve(),
    }));
    const tree = new ProjectTreeProvider(empty);
    try {
      assert.deepEqual(await tree.getChildren(), []);
    } finally {
      tree.dispose();
      empty.dispose();
    }
  });
});
