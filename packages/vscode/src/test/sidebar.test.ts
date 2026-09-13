import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { TwigLoaderPaths } from '@wicker/core';

import { LoaderPathMemory } from '../loaderPathMemory.js';
import { SessionManager } from '../session.js';
import { isBundleNamespace, ProjectTreeProvider, type SidebarNode } from '../sidebar.js';

const ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');
const rootUri = vscode.Uri.file(ROOT);

async function openTemplate(...segments: string[]): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(rootUri, ...segments));
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

function tooltipText(item: vscode.TreeItem): string {
  return typeof item.tooltip === 'string' ? item.tooltip : item.tooltip?.value ?? '';
}

function section(tree: ProjectTreeProvider, project: SidebarNode | undefined, name: 'controllers' | 'templates'): SidebarNode {
  assert.ok(project);
  const node = tree.getChildren(project).find((child) => child.kind === 'section' && child.section === name);
  assert.ok(node);
  return node;
}

function templateGroups(tree: ProjectTreeProvider, project: SidebarNode | undefined): SidebarNode[] {
  return tree.getChildren(section(tree, project, 'templates'));
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
    sessions = new SessionManager(new LoaderPathMemory({
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

  test('groups each project by namespace and shows resolution source and real template targets', () => {
    const roots = provider.getChildren();
    assert.equal(roots.length, 2);
    const project = roots.find((node) => node.root.toString() === rootUri.toString());
    assert.ok(project);
    const children = provider.getChildren(project);
    assert.ok(children.every((node) => provider.getTreeItem(node).label !== 'Namespaces'));
    assert.match(tooltipText(provider.getTreeItem(project)), /Namespaces: Configuration only/);
    const warning = children.find((node) => node.kind === 'warning' && node.reason === 'namespaces');
    assert.ok(warning);
    const warningItem = provider.getTreeItem(warning);
    assert.equal(warningItem.label, 'Bundle namespaces unavailable');
    assert.equal(warningItem.command, undefined);
    assert.equal(warningItem.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.deepEqual(provider.getChildren(warning).map((node) => provider.getTreeItem(node).label),
      ['Retry', 'Open console settings']);
    for (const action of provider.getChildren(warning)) {
      assert.equal(provider.getTreeItem(provider.getParent(action)!).id, warningItem.id);
    }
    assert.deepEqual(children.filter((node) => node.kind === 'section').map((node) => provider.getTreeItem(node).label),
      ['Controllers', 'Templates']);
    const groups = templateGroups(provider, project).filter((node) => node.kind === 'namespace');
    assert.deepEqual(groups.map((node) => node.namespace), ['', '@Design']);
    const main = groups[0];
    const design = groups[1];
    assert.ok(main && design);
    assert.equal(provider.getTreeItem(main).label, 'Application');
    assert.equal(provider.getTreeItem(design).accessibilityInformation?.label, '@Design, 1');
    const namespaced = provider.getChildren(design);
    assert.equal(namespaced.length, 1);
    const leaf = namespaced[0];
    assert.ok(leaf);
    const item = provider.getTreeItem(leaf);
    assert.equal(item.label, 'badge.html.twig');
    assert.equal(item.resourceUri?.toString(), vscode.Uri.joinPath(rootUri, 'design/badge.html.twig').toString());
    assert.equal(provider.getTreeItem(provider.getParent(leaf)!).id, provider.getTreeItem(design).id);
    const templates = section(provider, project, 'templates');
    assert.equal(provider.getTreeItem(provider.getParent(design)!).id, provider.getTreeItem(templates).id);
    assert.equal(provider.getTreeItem(provider.getParent(templates)!).id, provider.getTreeItem(project).id);
    const application = provider.getChildren(main);
    assert.deepEqual(application.map((node) => provider.getTreeItem(node).label), ['task', 'base.html.twig']);
    const task = application[0];
    assert.ok(task);
    assert.equal(provider.getTreeItem(task).description, '2');
    const taskFiles = provider.getChildren(task);
    assert.deepEqual(taskFiles.map((node) => provider.getTreeItem(node).label), ['_row.html.twig', 'index.html.twig']);
    assert.ok(taskFiles.some((node) => node.kind === 'template' && node.name === 'task/index.html.twig'));
    assert.equal(provider.getTreeItem(provider.getParent(taskFiles[0]!)!).id, provider.getTreeItem(task).id);
    assert.equal(provider.getTreeItem(provider.getParent(task)!).id, provider.getTreeItem(main).id);
  });

  test('opens a namespaced template through the registered sidebar command', async () => {
    await vscode.commands.executeCommand('wicker.openTemplate', rootUri, '@Design/badge.html.twig');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),
      vscode.Uri.joinPath(rootUri, 'design/badge.html.twig').toString());
  });

  test('browses controller actions, opens current targets and keeps nested projects separate', async () => {
    const project = provider.getChildren().find((node) => node.root.toString() === rootUri.toString());
    const controllers = section(provider, project, 'controllers');
    const rows = provider.getChildren(controllers);
    assert.deepEqual(rows.map((node) => provider.getTreeItem(node).label), ['TaskController']);
    const controller = rows[0]!;
    assert.equal(provider.getTreeItem(provider.getParent(controller)!).id, provider.getTreeItem(controllers).id);
    const controllerItem = provider.getTreeItem(controller);
    assert.ok(controllerItem.command);
    await vscode.commands.executeCommand(controllerItem.command.command, ...controllerItem.command.arguments!);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),
      vscode.Uri.joinPath(rootUri, 'src/Controller/TaskController.php').toString());
    const actions = provider.getChildren(controller);
    assert.deepEqual(actions.map((node) => provider.getTreeItem(node).label), ['index()', 'missing()', 'badNamespace()']);
    for (const action of actions) {
      const leaf = provider.getChildren(action)[0]!;
      assert.ok(leaf.kind === 'controllerTemplate');
      assert.equal(provider.getTreeItem(provider.getParent(action)!).id, controllerItem.id);
      assert.equal(provider.getTreeItem(provider.getParent(leaf)!).id, provider.getTreeItem(action).id);
      const command = provider.getTreeItem(action).command!;
      await vscode.commands.executeCommand(command.command, ...command.arguments!);
      const editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
      assert.ok(editor);
      assert.equal(editor.document.getText(editor.selection), leaf.name);
      const item = provider.getTreeItem(leaf);
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
    const nested = provider.getChildren().find((node) => node.root.toString() === vscode.Uri.joinPath(rootUri, 'nested-app').toString());
    assert.deepEqual(provider.getChildren(section(provider, nested, 'controllers')).map((node) => provider.getTreeItem(node).label),
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
    const project = provider.getChildren().find((node) => node.root.toString() === rootUri.toString());
    const controllers = section(provider, project, 'controllers');
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
      const rows = provider.getChildren(controllers);
      assert.equal(rows.length, 2);
      assert.notEqual(provider.getTreeItem(rows[0]!).id, provider.getTreeItem(rows[1]!).id);
      const controller = rows.find((node) => node.kind === 'controller' && node.className === 'App\\Controller\\PageController')!;
      const actions = provider.getChildren(controller);
      assert.deepEqual(actions.map((node) => provider.getTreeItem(node).label), ['index()', 'attribute()']);
      const action = actions[0]!;
      const leaves = provider.getChildren(action);
      assert.deepEqual(leaves.map((node) => provider.getTreeItem(node).label),
        ['task/index.html.twig', '@Infrastructure/status.html.twig']);
      const item = provider.getTreeItem(action);
      // Old nodes/commands should resolve fresh offsets after unrelated edits.
      await replace(source.replace('<?php', '<?php\n// shifted 💚\n'));
      assert.equal(provider.getTreeItem(action).id, item.id);
      await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
      assert.equal(php.getText(vscode.window.activeTextEditor!.selection), 'task/index.html.twig');
      const attribute = provider.getTreeItem(actions[1]!);
      await vscode.commands.executeCommand(attribute.command!.command, ...attribute.command!.arguments!);
      const editor = vscode.window.activeTextEditor!;
      assert.match(php.lineAt(editor.selection.start.line).text, /#\[Template/);
      assert.equal(php.getText(editor.selection), 'task/_row.html.twig');
      const bundle = provider.getTreeItem(leaves[1]!);
      assert.ok(bundle.command, 'explicit render targets stay available when bundle browsing is hidden');
      await vscode.commands.executeCommand(bundle.command.command, ...bundle.command.arguments!);
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),
        vscode.Uri.joinPath(rootUri, 'vendor/sidebar-fixture/templates/status.html.twig').toString());
      await replace('<?php // controllers removed');
      assert.deepEqual(provider.getChildren(controllers), []);
      assert.equal(provider.getTreeItem(controller).command, undefined);
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
    assert.deepEqual(provider.getChildren(controllers).map((node) => provider.getTreeItem(node).label), ['TaskController']);
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

  test('warning actions recover console resolution and saved answers stay in the tooltip', async () => {
    const project = provider.getChildren().find((node) => node.root.toString() === rootUri.toString());
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
      const warning = provider.getChildren(project).find((child) => child.kind === 'warning' && child.reason === 'namespaces');
      assert.ok(warning);
      const retry = provider.getChildren(warning).find((child) => child.kind === 'action' && child.action === 'retry');
      assert.ok(retry);
      const command = provider.getTreeItem(retry).command;
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
      assert.match(tooltipText(provider.getTreeItem(project)), /Namespaces: Symfony console/);
      assert.ok(provider.getChildren(project).every((child) => child.kind === 'section'));
      assert.deepEqual(provider.getChildren(warning), []);
      assert.equal(provider.getTreeItem(retry).command, undefined);
      assert.equal(await vscode.commands.executeCommand(command.command, ...command.arguments!), false);

      await settings.update('console.command', [node, '-e', 'process.exit(1)', '--'], vscode.ConfigurationTarget.Workspace);
      await sessions.refreshAll();
      assert.match(tooltipText(provider.getTreeItem(project)), /Namespaces: Saved from Symfony/);
      assert.ok(provider.getChildren(project).every((child) => child.kind === 'section'));
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
    const project = provider.getChildren().find((node) => node.root.toString() === rootUri.toString());
    assert.ok(project);
    const settings = vscode.workspace.getConfiguration('wicker');
    const previousLimit = settings.inspect<number>('index.maxFiles')?.workspaceValue;
    try {
      await settings.update('index.maxFiles', 1, vscode.ConfigurationTarget.Workspace);
      await sessions.refreshAll();
      const warning = provider.getChildren(project).find((node) => node.kind === 'warning' && node.reason === 'indexLimit');
      assert.ok(warning);
      assert.equal(provider.getTreeItem(warning).label, 'Template index limit reached');
      const actions = provider.getChildren(warning);
      assert.deepEqual(actions.map((node) => provider.getTreeItem(node).label), ['Retry', 'Open index settings']);
      assert.notEqual(provider.getTreeItem(actions[0]!).id, provider.getTreeItem(actions[1]!).id);
    } finally {
      await settings.update('index.maxFiles', previousLimit, vscode.ConfigurationTarget.Workspace);
      await sessions.refreshAll();
    }
    assert.ok(provider.getChildren(project).every((node) => node.kind !== 'warning' || node.reason !== 'indexLimit'));
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
    const project = provider.getChildren().find((node) => node.root.toString() === rootUri.toString());
    assert.ok(project);
    const groups = () => templateGroups(provider, project)
      .filter((node) => node.kind === 'namespace').map((node) => node.namespace);
    assert.deepEqual(groups(), ['', '@Design']);
    assert.equal(provider.getTreeItem(section(provider, project, 'templates')).description, '4');
    assert.ok(sessions.sessionFor({ uri: rootUri })?.lookup('@Infrastructure/status.html.twig'));
    let changes = 0;
    const listener = provider.onDidChangeTreeData(() => { changes += 1; });
    try {
      provider.setShowBundleTemplates(true);
      await vscode.commands.executeCommand('wicker.showBundleTemplates');
      assert.deepEqual(groups(), ['', '@Design', '@Infrastructure']);
      assert.equal(provider.getTreeItem(section(provider, project, 'templates')).description, '5');
      const bundle = templateGroups(provider, project).find((node) => node.kind === 'namespace' && node.namespace === '@Infrastructure');
      assert.ok(bundle);
      assert.equal(provider.getChildren(bundle).length, 1);
      provider.setShowBundleTemplates(false);
      await vscode.commands.executeCommand('wicker.hideBundleTemplates');
      assert.deepEqual(provider.getChildren(bundle), []);
      assert.deepEqual(groups(), ['', '@Design']);
      assert.equal(changes, 2);
      await vscode.commands.executeCommand('wicker.openTemplate', rootUri, '@Infrastructure/status.html.twig');
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(),
        vscode.Uri.joinPath(rootUri, 'vendor/sidebar-fixture/templates/status.html.twig').toString());
      assert.equal(await vscode.commands.executeCommand('wicker.revealTemplate'), true);
      // A provider restored with the saved "show" preference includes bundles immediately.
      const restored = new ProjectTreeProvider(sessions, true);
      try {
        assert.ok(templateGroups(restored, project).some((node) => node.kind === 'namespace' && node.namespace === '@Infrastructure'));
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
    const includesNewFile = (): boolean => {
      const root = provider.getChildren().find((node) => node.root.toString() === rootUri.toString());
      const main = templateGroups(provider, root).find((node) => node.kind === 'namespace' && node.namespace === '');
      return provider.getChildren(main).some((node) => node.kind === 'template' && node.name === 'sidebar-test.html.twig');
    };
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from('Sidebar test'));
      await sessions.refreshAll();
      assert.ok(includesNewFile());
      assert.ok(changes > 0);
    } finally {
      listener.dispose();
      await vscode.workspace.fs.delete(uri);
      await sessions.refreshAll();
    }
    assert.ok(!includesNewFile());
  });

  test('reveals deeply nested folders, keeps namespaces separate and removes empty folders', async () => {
    const directories = [
      vscode.Uri.joinPath(rootUri, 'templates', '__sidebar_tree_test'),
      vscode.Uri.joinPath(rootUri, 'design', '__sidebar_tree_test'),
      vscode.Uri.joinPath(rootUri, 'templates', '__sidebar_tree_test_extra'),
    ];
    const findFolder = (namespace: string) => {
      const root = provider.getChildren().find((node) => node.root.toString() === rootUri.toString());
      assert.ok(root);
      const group = templateGroups(provider, root).find((node) => node.kind === 'namespace' && node.namespace === namespace);
      assert.ok(group);
      return provider.getChildren(group).find((node) => node.kind === 'folder' && node.path === '__sidebar_tree_test');
    };
    try {
      for (const directory of directories) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(directory, 'partials'));
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, 'partials/card.html.twig'), Buffer.from('Card'));
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, 'index.html.twig'), Buffer.from('Index'));
      }
      await sessions.refreshAll();
      await vscode.commands.executeCommand('wicker.reindex');
      const main = findFolder('');
      const design = findFolder('@Design');
      assert.ok(main && design);
      assert.notEqual(provider.getTreeItem(main).id, provider.getTreeItem(design).id);
      for (const folder of [main, design]) {
        assert.equal(provider.getTreeItem(folder).description, '2');
        const children = provider.getChildren(folder);
        assert.deepEqual(children.map((node) => provider.getTreeItem(node).label), ['partials', 'index.html.twig']);
        const partials = children[0]!;
        const card = provider.getChildren(partials)[0]!;
        const item = provider.getTreeItem(card);
        assert.equal(item.label, 'card.html.twig');
        assert.equal(provider.getTreeItem(provider.getParent(card)!).id, provider.getTreeItem(partials).id);
        assert.equal(provider.getTreeItem(provider.getParent(partials)!).id, provider.getTreeItem(folder).id);
        assert.ok(item.command && item.resourceUri);
        await vscode.commands.executeCommand(item.command.command, ...item.command.arguments!);
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), item.resourceUri.toString());
        assert.equal(await vscode.commands.executeCommand('wicker.revealTemplate'), true);
        assert.equal(provider.getTreeItem(card).tooltip,
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
    assert.equal(findFolder(''), undefined);
    assert.equal(findFolder('@Design'), undefined);
  });

  test('clears disabled projects and rejects stale open/reveal actions until enabled again', async () => {
    await openTemplate('templates', 'task', 'index.html.twig');
    const before = vscode.window.activeTextEditor?.document.uri.toString();
    const project = provider.getChildren()[0];
    assert.ok(project);
    const settings = vscode.workspace.getConfiguration('wicker');
    await settings.update('enable', false, vscode.ConfigurationTarget.Workspace);
    try {
      assert.deepEqual(provider.getChildren(), []);
      assert.deepEqual(provider.getChildren(project), []);
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
    assert.equal(provider.getChildren().length, 2);
    assert.equal(await vscode.commands.executeCommand('wicker.revealTemplate'), true);
  });

  test('has an empty tree when no Symfony project is detected', () => {
    const empty = new SessionManager(new LoaderPathMemory({
      keys: () => [], get: <T>(_key: string, fallback?: T): T | undefined => fallback,
      update: () => Promise.resolve(),
    }));
    const tree = new ProjectTreeProvider(empty);
    try {
      assert.deepEqual(tree.getChildren(), []);
    } finally {
      tree.dispose();
      empty.dispose();
    }
  });
});
