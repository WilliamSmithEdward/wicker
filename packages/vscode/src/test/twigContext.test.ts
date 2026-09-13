import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import * as vscode from 'vscode';

const ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');

async function deleteIfPresent(uri: vscode.Uri): Promise<void> {
  try { await vscode.workspace.fs.delete(uri); }
  catch (error) { if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') { throw error; } }
}

async function replace(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

async function variables(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, position);
  return list?.items.filter((item) => item.detail === 'Wicker · Twig context' || item.detail === 'Wicker · Controller context') ?? [];
}

async function labels(document: vscode.TextDocument, position: vscode.Position): Promise<string[]> {
  return (await variables(document, position)).map((item) => typeof item.label === 'string' ? item.label : item.label.label).sort();
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'template edits should update context completion');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite('Twig context across templates', () => {
  let page: vscode.TextDocument;
  let partial: vscode.TextDocument;
  let layout: vscode.TextDocument;
  let controller: vscode.TextDocument;
  const originals = new Map<vscode.TextDocument, string>();

  suiteSetup(async () => {
    await vscode.extensions.getExtension('WilliamSmithE.wicker')!.activate();
    const documents = await Promise.all([
      'templates/task/index.html.twig', 'templates/task/_row.html.twig', 'templates/base.html.twig', 'src/Controller/TaskController.php',
    ].map((file) => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ROOT, file)))));
    page = documents[0]!;
    partial = documents[1]!;
    layout = documents[2]!;
    controller = documents[3]!;
    for (const document of [page, partial, layout, controller]) { originals.set(document, document.getText()); }
  });

  teardown(async () => { for (const [document, text] of originals) { await replace(document, text); } });
  suiteTeardown(async () => {
    for (const [document] of originals) {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  async function at(document: vscode.TextDocument, marked: string): Promise<vscode.Position> {
    const offset = marked.indexOf('§');
    assert.ok(offset >= 0);
    await replace(document, marked.replace('§', ''));
    return document.positionAt(offset);
  }

  test('the existing isolated row include supplies task with a Twig source hover', async () => {
    const position = await at(partial, '{{ ta§sk }}');
    assert.deepEqual(await labels(partial, position), ['task']);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', partial.uri, position);
    const text = hovers?.flatMap((item) => item.contents.map((content) => typeof content === 'string' ? content : content.value)).join('\n') ?? '';
    assert.match(text, /Twig context/);
    assert.match(text.replaceAll('&nbsp;', ' '), /include with/);
    assert.match(text, /templates\/task\/index.html.twig/);
    assert.doesNotMatch(text, /Explicitly passed at/);
  });

  test('unsaved caller edits change keys and only behavior immediately', async () => {
    const position = await at(partial, '{{ § }}');
    await replace(page, "{% include 'task/_row.html.twig' with {heading: 'x'} only %}");
    assert.deepEqual(await labels(partial, position), ['heading']);
    await replace(page, "{% set local = 1 %}{% include 'task/_row.html.twig' %}");
    assert.deepEqual(await labels(partial, position), ['local', 'openCount', 'tasks']);
    await replace(page, "{{ include('task/_row.html.twig', {label: 'x'}, with_context: false) }}");
    assert.deepEqual(await labels(partial, position), ['label']);
  });

  test('unsaved controller edits reach included templates through the caller', async () => {
    await replace(page, "{% include 'task/_row.html.twig' %}");
    const position = await at(partial, '{{ § }}');
    await replace(controller, originals.get(controller)!.replace("'tasks' =>", "'changedTasks' =>"));
    assert.deepEqual(await labels(partial, position), ['changedTasks', 'openCount']);
  });

  test('local scope suggestions replace whole identifiers and do not escape their scope', async () => {
    let position = await at(partial, '{% set local = 1 %}{% for key, item in items %}{{ it§em }}{% endfor %}');
    let result = await variables(partial, position);
    assert.deepEqual(result.map((item) => item.label).sort(), ['item', 'key', 'local', 'loop', 'task']);
    const range = result.find((item) => item.label === 'item')!.range!;
    assert.equal(partial.getText(range instanceof vscode.Range ? range : range.replacing), 'item');
    position = await at(partial, '{% for key, item in items %}{% endfor %}{{ § }}');
    assert.deepEqual(await labels(partial, position), ['task']);
    position = await at(partial, '{% macro card(title) %}{{ § }}{% endmacro %}');
    assert.deepEqual(await labels(partial, position), ['title', 'varargs']);
    position = await at(partial, '{% with {title: "x"} only %}{{ § }}{% endwith %}');
    result = await variables(partial, position);
    assert.deepEqual(result.map((item) => item.label), ['title']);
  });

  test('layout and child block contexts follow unsaved inheritance and parent assignments', async () => {
    await replace(page, "{% extends 'base.html.twig' %}{% block body %}{{ before }}{% endblock %}{% set fromPage = 1 %}");
    let position = await at(layout, '{% set before = 1 %}{{ § }}{% block body %}{% endblock %}');
    const baseLabels = await labels(layout, position);
    assert.ok(baseLabels.includes('tasks'));
    assert.ok(baseLabels.includes('fromPage'));
    position = await at(page, "{% extends 'base.html.twig' %}{% block body %}{{ § }}{% endblock %}");
    assert.deepEqual(await labels(page, position), ['before', 'openCount', 'tasks']);
    await replace(layout, '{% set renamed = 1 %}{% block body %}{% endblock %}');
    assert.deepEqual(await labels(page, position), ['openCount', 'renamed', 'tasks']);
  });

  test('created, changed, renamed and deleted on-disk callers refresh without a rebuild command', async () => {
    const uri = vscode.Uri.file(path.join(ROOT, 'templates/__wicker_context_probe.html.twig'));
    const renamed = vscode.Uri.file(path.join(ROOT, 'templates/__wicker_context_renamed.html.twig'));
    const position = await at(partial, '{{ § }}');
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from("{% include 'task/_row.html.twig' with {created: 1} only %}"));
      await eventually(async () => (await labels(partial, position)).includes('created'));
      await vscode.workspace.fs.writeFile(uri, Buffer.from("{% include 'task/_row.html.twig' with {changed: 1} only %}"));
      await eventually(async () => (await labels(partial, position)).includes('changed') && !(await labels(partial, position)).includes('created'));
      await vscode.workspace.fs.rename(uri, renamed);
      await eventually(async () => (await labels(partial, position)).includes('changed'));
      await vscode.workspace.fs.delete(renamed);
      await eventually(async () => !(await labels(partial, position)).includes('changed'));
    } finally {
      for (const candidate of [uri, renamed]) {
        await deleteIfPresent(candidate);
      }
    }
  });

  test('unsaved caller changes revert when discarded', async () => {
    const position = await at(partial, '{{ § }}');
    await replace(page, "{% include 'task/_row.html.twig' with {temporary: 1} only %}");
    assert.deepEqual(await labels(partial, position), ['temporary']);
    await vscode.window.showTextDocument(page);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await eventually(async () => (await labels(partial, position)).includes('task') && !(await labels(partial, position)).includes('temporary'));
  });

  test('nested project template sources cannot contribute to the parent context', async () => {
    const nested = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ROOT, 'nested-app/templates/task/_row.html.twig')));
    const previous = nested.getText();
    try {
      await replace(nested, "{% include 'task/_row.html.twig' with {nestedSecret: 1} only %}");
      const position = await at(partial, '{{ § }}');
      assert.ok(!(await labels(partial, position)).includes('nestedSecret'));
    } finally {
      await replace(nested, previous);
      await vscode.window.showTextDocument(nested);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  test('disable applies to local and inherited context alike', async () => {
    const config = vscode.workspace.getConfiguration('wicker');
    const previous = config.inspect<boolean>('enable')?.workspaceValue;
    const position = await at(partial, '{% set local = 1 %}{{ § }}');
    try {
      await config.update('enable', false, vscode.ConfigurationTarget.Workspace);
      assert.deepEqual(await labels(partial, position), []);
    } finally {
      await config.update('enable', previous, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
    }
  });
});
