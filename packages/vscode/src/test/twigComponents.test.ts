import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { ProjectTreeProvider } from '../sidebar.js';
import { memorySessions } from './support.js';

const ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');
const PHP = 'src/Twig/Components/Alert.php';
const CONSOLE = `const fs = require('node:fs');
if (!process.argv.includes('debug:twig-component')) {
  process.stdout.write(JSON.stringify({loader_paths: {'(None)': ['templates'], '@Nested': ['nested-app/templates']}, filters: {}, functions: {component: []}}));
} else {
  let name = 'Alert';
  try { name = fs.readFileSync('${PHP}', 'utf8').match(/AsTwigComponent\\('([^']+)'/)?.[1] ?? name; } catch {}
  let rows = '| Name | Class | Template | Type |\\n';
  if (fs.existsSync('${PHP}')) rows += '| ' + name + ' | App\\\\Twig\\\\Components\\\\Alert | components/Alert.html.twig | |\\n';
  if (fs.existsSync('templates/components/Badge.html.twig')) rows += '| Badge | | components/Badge.html.twig | Anon |\\n';
  if (fs.existsSync('templates/components/Added.html.twig')) rows += '| Added | | components/Added.html.twig | Anon |\\n';
  rows += '| Nested | | @Nested/task/_row.html.twig | Anon |\\n';
  process.stdout.write(rows);
}`;

function uri(file: string): vscode.Uri { return vscode.Uri.file(path.join(ROOT, file)); }
async function replace(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Component surfaces should update');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function items(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
  const result = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, position);
  return result?.items.filter((item) => ['Wicker · Twig component', 'Wicker · Component prop'].includes(item.detail ?? '')) ?? [];
}

suite('Twig Components', () => {
  let page: vscode.TextDocument;
  let php: vscode.TextDocument;
  let badge: vscode.TextDocument;
  const originals = new Map<vscode.TextDocument, string>();
  const settings = vscode.workspace.getConfiguration('wicker');
  let previousCommand: string[] | undefined;
  let previousConsole: boolean | undefined;
  const node = process.env['npm_node_execpath'] ?? 'node';

  async function command(script: string): Promise<void> {
    await settings.update('console.command', [node, '-e', script, '--'], vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('wicker.reindex');
  }
  async function at(marked: string): Promise<vscode.Position> {
    const offset = marked.indexOf('§');
    assert.ok(offset >= 0);
    await replace(page, marked.replace('§', ''));
    return page.positionAt(offset);
  }
  async function definitions(position: vscode.Position): Promise<vscode.LocationLink[]> {
    const links = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', page.uri, position);
    return links?.filter((item): item is vscode.LocationLink => 'targetUri' in item) ?? [];
  }

  suiteSetup(async () => {
    await vscode.extensions.getExtension('WilliamSmithE.wicker')!.activate();
    previousCommand = settings.inspect<string[]>('console.command')?.workspaceValue;
    previousConsole = settings.inspect<boolean>('console.enabled')?.workspaceValue;
    await settings.update('console.enabled', true, vscode.ConfigurationTarget.Workspace);
    await command(CONSOLE);
    page = await vscode.workspace.openTextDocument(uri('templates/task/index.html.twig'));
    php = await vscode.workspace.openTextDocument(uri(PHP));
    badge = await vscode.workspace.openTextDocument(uri('templates/components/Badge.html.twig'));
    for (const document of [page, php, badge]) { originals.set(document, document.getText()); }
  });
  teardown(async () => { for (const [document, text] of originals) { await replace(document, text); } });
  suiteTeardown(async () => {
    for (const [document, text] of originals) {
      await replace(document, text);
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    await settings.update('console.command', previousCommand, vscode.ConfigurationTarget.Workspace);
    await settings.update('console.enabled', previousConsole, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('wicker.reindex');
  });

  /*
   * A registration pairs a name, a class and a template, and no one file holds
   * all three: the class carries an attribute the template never sees, and an
   * anonymous component has no class at all.
   */
  test('the Components section lists registrations and opens both of their files', async () => {
    const sessions = memorySessions();
    await sessions.initialize();
    const tree = new ProjectTreeProvider(sessions);
    try {
      const root = (await tree.getChildren()).find((node) => node.root.toString() === uri('').toString())!;
      const section = (await tree.getChildren(root)).find((node) => node.kind === 'section' && node.section === 'components');
      assert.ok(section, 'a project with registered components should carry the section');
      const rows = await tree.getChildren(section);
      const labels = await Promise.all(rows.map(async (node) => (await tree.getTreeItem(node)).label));
      assert.ok(labels.includes('<twig:Alert>'), `expected Alert among ${JSON.stringify(labels)}`);

      const alert = rows[labels.indexOf('<twig:Alert>')]!;
      assert.deepEqual(tree.getParent(alert), section);
      const parts = await tree.getChildren(alert);
      assert.deepEqual(parts.map((node) => node.kind === 'componentPart' ? node.part : ''), ['template', 'class']);
      for (const [part, file] of [[parts[0]!, 'templates/components/Alert.html.twig'], [parts[1]!, PHP]] as const) {
        const item = await tree.getTreeItem(part);
        assert.deepEqual(tree.getParent(part), alert);
        await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), uri(file).toString());
      }

      // Anonymous components are registered by template alone, so the class
      // row would point at nothing and is left off rather than shown broken.
      const anonymous = rows[labels.indexOf('<twig:Badge>')];
      assert.ok(anonymous);
      assert.equal((await tree.getTreeItem(anonymous)).description, 'Anonymous');
      assert.deepEqual((await tree.getChildren(anonymous)).map((node) => node.kind === 'componentPart' ? node.part : ''), ['template']);
    } finally {
      tree.dispose(); sessions.dispose();
    }
  });

  test('registered component names complete in HTML, closing tags and Twig calls', async () => {
    for (const source of ['<twig:Al§ert />', '</twig:Al§ert>', "{{ component('Al§ert') }}", "{% component 'Al§ert' %}{% endcomponent %}"]) {
      const position = await at(source);
      const result = await items(page, position);
      const item = result.find((entry) => entry.label === 'Alert');
      assert.ok(item);
      const range = item.range instanceof vscode.Range ? item.range : item.range!.replacing;
      assert.equal(page.getText(range), 'Alert');
    }
  });

  test('Go to Definition offers the class and template with correct source selections', async () => {
    const links = await definitions(await at('<twig:Al§ert />'));
    assert.equal(links.length, 2);
    const classLink = links.find((link) => link.targetUri.fsPath.endsWith('Alert.php'))!;
    assert.equal(php.getText(classLink.targetSelectionRange), 'Alert');
    assert.ok(links.some((link) => link.targetUri.fsPath.endsWith('Alert.html.twig')));
  });

  test('props complete, avoid duplicates and retain existing values', async () => {
    let position = await at('<twig:Alert :message="text" §/>');
    let result = await items(page, position);
    assert.deepEqual(result.map((item) => item.label).sort(), ['dismissible', 'tone']);
    assert.equal((result.find((item) => item.label === 'tone')!.insertText as vscode.SnippetString).value, 'tone="$1"');
    position = await at('<twig:Alert to§ne="info" />');
    result = await items(page, position);
    assert.equal(result.find((item) => item.label === 'tone')!.insertText, 'tone');
    const links = await definitions(position);
    assert.equal(links.length, 1);
    assert.equal(php.getText(links[0]!.targetSelectionRange), 'tone');
  });

  test('component and prop hovers explain their source', async () => {
    for (const [marked, heading] of [['<twig:Al§ert />', 'Twig component'], ['<twig:Alert mes§sage="hello" />', 'Component prop']]) {
      const position = await at(marked!);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', page.uri, position);
      const content = hovers?.flatMap((hover) => hover.contents.map((item) => typeof item === 'string' ? item : item.value)).join('\n') ?? '';
      assert.ok(content.includes(`**${heading}**`));
      assert.ok(content.includes(heading === 'Twig component' ? 'components/Alert.html.twig' : 'src/Twig/Components/Alert.php'));
    }
  });

  test('unsaved PHP prop changes and discarded edits are reflected immediately', async () => {
    const position = await at('<twig:Alert §/>');
    await replace(php, originals.get(php)!.replace('$message', '$heading'));
    assert.ok((await items(page, position)).some((item) => item.label === 'heading'));
    assert.ok(!(await items(page, position)).some((item) => item.label === 'message'));
    await vscode.window.showTextDocument(php);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert.ok((await items(page, position)).some((item) => item.label === 'message'));
  });

  test('anonymous component props track unsaved Twig edits and navigate to declarations', async () => {
    await replace(badge, "{% props label, size = 'small' %}<b>{{ label }}</b>");
    let position = await at('<twig:Badge §/>');
    assert.deepEqual((await items(page, position)).map((item) => item.label).sort(), ['label', 'size']);
    position = await at('<twig:Badge si§ze="large" />');
    const links = await definitions(position);
    assert.equal(badge.getText(links[0]!.targetSelectionRange), 'size');
    assert.equal((await definitions(await at('<twig:Ba§dge />'))).length, 1);
  });

  test('saved registration edits refresh the component catalogue automatically', async () => {
    const position = await at('<twig:§/>');
    try {
      await replace(php, originals.get(php)!.replace("('Alert')", "('Notice')"));
      assert.ok(await php.save());
      await eventually(async () => (await items(page, position)).some((item) => item.label === 'Notice'));
      assert.ok(!(await items(page, position)).some((item) => item.label === 'Alert'));
    } finally {
      await replace(php, originals.get(php)!); await php.save(); await vscode.commands.executeCommand('wicker.reindex');
    }
  });

  test('creating and deleting an anonymous component updates discovery', async () => {
    const added = uri('templates/components/Added.html.twig');
    const position = await at('<twig:§/>');
    try {
      await vscode.workspace.fs.writeFile(added, Buffer.from('{% props added %}'));
      await eventually(async () => (await items(page, position)).some((item) => item.label === 'Added'));
      await vscode.workspace.fs.delete(added);
      await eventually(async () => !(await items(page, position)).some((item) => item.label === 'Added'));
    } finally {
      try { await vscode.workspace.fs.delete(added); } catch { /* Already removed. */ }
    }
  });

  test('unavailable discovery and disabled extension stay quiet', async () => {
    const position = await at('<twig:Alert §/>');
    const previous = settings.inspect<boolean>('enable')?.workspaceValue;
    try {
      await command("if (process.argv.includes('debug:twig-component')) process.exit(1); " + CONSOLE);
      assert.equal((await items(page, position)).length, 0);
      await command(CONSOLE);
      await settings.update('enable', false, vscode.ConfigurationTarget.Workspace);
      assert.equal((await items(page, position)).length, 0);
      assert.equal((await definitions(position)).length, 0);
    } finally {
      await settings.update('enable', previous, vscode.ConfigurationTarget.Workspace);
      await command(CONSOLE);
    }
  });

  test('nested project component sources cannot contribute to a parent', async () => {
    const nested = await vscode.workspace.openTextDocument(uri('nested-app/templates/task/_row.html.twig'));
    const original = nested.getText();
    try {
      await replace(nested, '{% props privateProp %}');
      assert.equal((await items(page, await at('<twig:Nested §/>'))).length, 0);
      assert.equal((await definitions(await at('<twig:Ne§sted />'))).length, 0);
    } finally {
      await replace(nested, original);
      await vscode.window.showTextDocument(nested);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });
});
