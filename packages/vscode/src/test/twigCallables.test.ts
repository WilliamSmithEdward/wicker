import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import * as vscode from 'vscode';

const ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');
const PROBE = 'src/WickerCallableProbe.php';

// Exercise the real process runner, refresh events and registered providers.
// PHP is absent on the test host; this console double reads saved project files.
const CONSOLE = `const fs = require('node:fs');
const nested = process.cwd().endsWith('nested-app');
let custom = 'price';
try { custom = fs.readFileSync('${PROBE}', 'utf8').match(/filter: (\\w+)/)?.[1] ?? custom; } catch {}
let extra = {};
try { extra = JSON.parse(fs.readFileSync('config/packages/wicker_callable_probe.yaml', 'utf8')); } catch {}
const answer = { loader_paths: {'(None)': ['templates'], '@Design': ['design']},
  filters: {upper: ['string'], raw: null, [nested ? 'nested_price' : custom]: ['precision = 2'], ...extra},
  functions: {path: ['name', 'parameters'], 'render_*': ['strategy'], range: ['start', 'end']} };
process.stdout.write(JSON.stringify(answer));`;

async function replace(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

async function eventually(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Twig callable discovery should reach the editor');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function items(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, position);
  return list?.items.filter((item) => item.detail?.startsWith('Wicker · Twig ')) ?? [];
}

function problems(document: vscode.TextDocument): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(document.uri).filter((item) => typeof item.code === 'string' && item.code.startsWith('unknown-twig-'));
}

suite('Twig filters and functions', () => {
  let template: vscode.TextDocument;
  let original: string;
  let previousCommand: string[] | undefined;
  let previousConsole: boolean | undefined;
  const settings = vscode.workspace.getConfiguration('wicker');
  const node = process.env['npm_node_execpath'] ?? 'node';
  const probe = vscode.Uri.file(path.join(ROOT, PROBE));
  const configProbe = vscode.Uri.file(path.join(ROOT, 'config/packages/wicker_callable_probe.yaml'));

  async function command(script = CONSOLE): Promise<void> {
    await settings.update('console.command', [node, '-e', script, '--'], vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('wicker.reindex');
  }

  async function at(marked: string): Promise<vscode.Position> {
    const offset = marked.indexOf('§');
    assert.ok(offset >= 0);
    await replace(template, marked.replace('§', ''));
    return template.positionAt(offset);
  }

  suiteSetup(async () => {
    await vscode.extensions.getExtension('WilliamSmithE.wicker')!.activate();
    previousCommand = settings.inspect<string[]>('console.command')?.workspaceValue;
    previousConsole = settings.inspect<boolean>('console.enabled')?.workspaceValue;
    await command();
    await settings.update('console.enabled', true, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('wicker.reindex');
    template = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ROOT, 'templates/task/index.html.twig')));
    original = template.getText();
  });

  teardown(async () => { await replace(template, original); });

  suiteTeardown(async () => {
    await replace(template, original);
    await vscode.window.showTextDocument(template);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await settings.update('console.command', previousCommand, vscode.ConfigurationTarget.Workspace);
    await settings.update('console.enabled', previousConsole, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('wicker.reindex');
  });

  test('completion replaces the full filter name and respects the pipe trigger', async () => {
    const position = await at('{{ total|pr§ice }}');
    const result = await items(template, position);
    assert.deepEqual(result.map((item) => item.label).sort(), ['price', 'raw', 'upper']);
    const price = result.find((item) => item.label === 'price')!;
    const range = price.range instanceof vscode.Range ? price.range : price.range!.replacing;
    assert.equal(template.getText(range), 'price');
    const triggerAt = await at('{{ total|§ }}');
    const triggered = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', template.uri, triggerAt, '|');
    assert.ok(triggered?.items.some((item) => item.label === 'price'));
  });

  test('function completion coexists with controller variables and template names', async () => {
    let position = await at('{{ § }}');
    const result = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', template.uri, position);
    assert.ok(result?.items.some((item) => item.label === 'path'));
    assert.ok(result?.items.some((item) => item.label === 'tasks'));
    assert.ok(!result?.items.some((item) => item.label === 'render_*'));
    position = await at("{% include 'ta§sk/index.html.twig' %}");
    const templates = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', template.uri, position);
    assert.ok(templates?.items.some((item) => item.label === 'task/_row.html.twig'));
    assert.equal((await items(template, position)).length, 0);
  });

  test('hover reports registration, honest argument metadata and official references', async () => {
    const position = await at('{{ title|up§per }}');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', template.uri, position);
    const hover = hovers?.find((item) => item.contents.some((content) => typeof content !== 'string' && content.value.includes('**Twig filter**')));
    assert.ok(hover);
    assert.equal(template.getText(hover.range), 'upper');
    const text = hover.contents.map((content) => typeof content === 'string' ? content : content.value).join('\n');
    assert.match(text, /not a Twig call signature/);
    assert.match(text, /https:\/\/twig.symfony.com\/doc\/3.x\/filters\/upper.html/);
  });

  test('diagnostics distinguish filters/functions and leave macros, tests and wildcard calls alone', async () => {
    await at(`{% from 'macros.twig' import link as nav %}
      {{ title|uppr }} {{ wrong() }} {{ render_esi('x') }} {{ nav() }} {{ app.method() }}
      {{ x is same as(y) }} {# {{ fake() }} #} {% verbatim %}{{ fake() }}{% endverbatim %}§`);
    await eventually(() => problems(template).length === 2);
    assert.deepEqual(problems(template).map((item) => item.code).sort(), ['unknown-twig-filter', 'unknown-twig-function']);
    assert.deepEqual(problems(template).map((item) => template.getText(item.range)).sort(), ['uppr', 'wrong']);
    assert.ok(problems(template).every((item) => item.severity === vscode.DiagnosticSeverity.Warning));
  });

  test('saved PHP edits, creation and deletion automatically reevaluate the surfaces', async () => {
    let document: vscode.TextDocument | undefined;
    try {
      await vscode.workspace.fs.writeFile(probe, Buffer.from('<?php // filter: special_price'));
      let position = await at('{{ value|§ }}');
      await eventually(async () => (await items(template, position)).some((item) => item.label === 'special_price'));
      document = await vscode.workspace.openTextDocument(probe);
      await replace(document, '<?php // filter: renamed_price');
      await at('{{ value|renamed_price }} {{ absent() }}§');
      await eventually(() => problems(template).length === 0);
      assert.ok(await document.save());
      position = await at('{{ value|renamed_price }} {{ value|special_price }} {{ value|§ }}');
      await eventually(async () => (await items(template, position)).some((item) => item.label === 'renamed_price') &&
        problems(template).some((item) => template.getText(item.range) === 'special_price'));
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      document = undefined;
      await vscode.workspace.fs.delete(probe);
      await eventually(async () => (await items(template, position)).some((item) => item.label === 'price') &&
        !(await items(template, position)).some((item) => item.label === 'renamed_price'));
    } finally {
      if (document !== undefined) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
      try { await vscode.workspace.fs.delete(probe); } catch { /* Removed during test. */ }
    }
  });

  test('configuration creation, changes and deletion refresh discovery', async () => {
    const position = await at('{{ value|§ }}');
    try {
      await vscode.workspace.fs.writeFile(configProbe, Buffer.from('{"configured":[]}'));
      await eventually(async () => (await items(template, position)).some((item) => item.label === 'configured'));
      await vscode.workspace.fs.writeFile(configProbe, Buffer.from('{"reconfigured":[]}'));
      await eventually(async () => (await items(template, position)).some((item) => item.label === 'reconfigured'));
      await vscode.workspace.fs.delete(configProbe);
      await eventually(async () => !(await items(template, position)).some((item) => item.label === 'reconfigured'));
    } finally {
      try { await vscode.workspace.fs.delete(configProbe); } catch { /* Removed during test. */ }
    }
  });

  test('a PHP change during a slow console run is not lost', async () => {
    const marker = vscode.Uri.file(path.join(__dirname, 'callable-refresh-started'));
    const position = await at('{{ value|§ }}');
    const slow = CONSOLE.replace('process.stdout.write(JSON.stringify(answer));',
      `if (!nested) { fs.writeFileSync(${JSON.stringify(marker.fsPath)}, custom); } setTimeout(() => process.stdout.write(JSON.stringify(answer)), 1000);`);
    try {
      await vscode.workspace.fs.writeFile(probe, Buffer.from('<?php // filter: before_change'));
      await command();
      await vscode.workspace.fs.writeFile(marker, Buffer.from(''));
      await settings.update('console.command', [node, '-e', slow, '--'], vscode.ConfigurationTarget.Workspace);
      await eventually(async () => Buffer.from(await vscode.workspace.fs.readFile(marker)).toString() === 'before_change');
      // The first run has captured the old registration, but has not answered.
      await vscode.workspace.fs.writeFile(probe, Buffer.from('<?php // filter: after_change'));
      await eventually(async () => (await items(template, position)).some((item) => item.label === 'after_change'));
      assert.ok(!(await items(template, position)).some((item) => item.label === 'before_change'));
    } finally {
      await vscode.workspace.fs.delete(probe);
      await vscode.workspace.fs.delete(marker);
      await command();
    }
  });

  test('unavailable or malformed discovery never produces unknown-name warnings and recovers', async () => {
    const position = await at('{{ value|bad }} {{ bad() }} {{ value|§ }}');
    await eventually(() => problems(template).length === 2);
    try {
      await command('process.exit(1)');
      assert.equal(problems(template).length, 0);
      assert.equal((await items(template, position)).length, 0);
      await command(`process.stdout.write(JSON.stringify({filters: {upper: [], bad: 42}, functions: null}))`);
      assert.equal(problems(template).length, 0);
      assert.ok((await items(template, position)).some((item) => item.label === 'upper'));
    } finally { await command(); }
    await eventually(() => problems(template).length === 2);
  });

  test('nested projects get their own callable catalog', async () => {
    const nested = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ROOT, 'nested-app/templates/task/_row.html.twig')));
    const originalNested = nested.getText();
    try {
      await replace(nested, '{{ value| }}');
      const result = await items(nested, nested.positionAt(9));
      assert.ok(result.some((item) => item.label === 'nested_price'));
      assert.ok(!result.some((item) => item.label === 'price'));
    } finally {
      await replace(nested, originalNested);
      await vscode.window.showTextDocument(nested);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  test('wicker.enable and the diagnostic preference apply to the new surfaces', async () => {
    const previous = settings.inspect<boolean>('enable')?.workspaceValue;
    const previousSeverity = settings.inspect<string>('diagnostics.unknownCallable')?.workspaceValue;
    const position = await at('{{ wrong() }} {{ value|§ }}');
    try {
      await settings.update('diagnostics.unknownCallable', 'off', vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
      assert.equal(problems(template).length, 0);
      assert.ok((await items(template, position)).length > 0);
      await settings.update('enable', false, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
      assert.equal((await items(template, position)).length, 0);
      const hoverAt = await at('{{ title|up§per }}');
      assert.equal((await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', template.uri, hoverAt))?.length ?? 0, 0);
    } finally {
      await settings.update('enable', previous, vscode.ConfigurationTarget.Workspace);
      await settings.update('diagnostics.unknownCallable', previousSeverity, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('wicker.reindex');
    }
  });
});
