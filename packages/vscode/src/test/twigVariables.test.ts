import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import * as vscode from 'vscode';

const ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');

async function replace(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

async function completions(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider', document.uri, position,
  );
  return list?.items.filter((item) => item.detail === 'Wicker · Controller context') ?? [];
}

async function hover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover[]> {
  const result = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider', document.uri, position,
  );
  return (result ?? []).filter((item) => item.contents.some((content) =>
    typeof content !== 'string' && content.value.includes('**Controller context**')));
}

function hoverText(result: readonly vscode.Hover[]): string {
  return result.flatMap((item) => item.contents.map((content) => typeof content === 'string' ? content : content.value)).join('\n');
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'controller edits should reach Twig providers');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite('Twig controller variables', () => {
  let template: vscode.TextDocument;
  let controller: vscode.TextDocument;
  let templateText: string;
  let controllerText: string;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('WilliamSmithE.wicker');
    assert.ok(extension);
    await extension.activate();
    template = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ROOT, 'templates/task/index.html.twig')));
    controller = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ROOT, 'src/Controller/TaskController.php')));
    templateText = template.getText();
    controllerText = controller.getText();
  });

  teardown(async () => {
    await replace(template, templateText);
    await replace(controller, controllerText);
  });

  suiteTeardown(async () => {
    for (const document of [template, controller]) {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  async function at(marked: string): Promise<vscode.Position> {
    const offset = marked.indexOf('§');
    assert.notEqual(offset, -1);
    await replace(template, marked.replace('§', ''));
    return template.positionAt(offset);
  }

  test('registered completion replaces the whole identifier with a supplied key', async () => {
    const position = await at('{{ ta§sks }}');
    const items = await completions(template, position);
    assert.deepEqual(items.map((item) => item.label).sort(), ['openCount', 'tasks']);
    const tasks = items.find((item) => item.label === 'tasks');
    assert.ok(tasks?.range);
    const range = tasks.range instanceof vscode.Range ? tasks.range : tasks.range.replacing;
    assert.equal(template.getText(range), 'tasks');
    assert.equal(tasks.kind, vscode.CompletionItemKind.Variable);
  });

  test('registered hover identifies the controller, call, path and precise variable range', async () => {
    const position = await at('{{ ta§sks }}');
    const result = await hover(template, position);
    assert.equal(result.length, 1);
    const text = hoverText(result);
    assert.match(text, /TaskController::index/);
    assert.match(text, /render/);
    assert.match(text, /src\/Controller\/TaskController/);
    assert.match(text, /1 of 1 indexed render sites/);
    assert.equal(template.getText(result[0]?.range), 'tasks');
  });

  test('unsaved PHP key changes update completion and remove the old hover', async () => {
    const position = await at('{{ ta§sks }}');
    await replace(controller, controllerText.replace("'tasks' =>", "'heading' =>"));
    await eventually(async () => {
      const items = await completions(template, position);
      return items.some((item) => item.label === 'heading') && !items.some((item) => item.label === 'tasks');
    });
    assert.equal((await hover(template, position)).length, 0);
    const headingPosition = await at('{{ hea§ding }}');
    assert.match(hoverText(await hover(template, headingPosition)), /TaskController::index/);
  });

  test('several render sites expose a union and explain partial availability', async () => {
    const extra = `
      public function alternate(): Response {
        return $this->render('task/index.html.twig', ['heading' => 'Other']);
      }
    `;
    const end = controllerText.lastIndexOf('}');
    await replace(controller, controllerText.slice(0, end) + extra + controllerText.slice(end));
    const position = await at('{{ hea§ding }}');
    await eventually(async () => (await completions(template, position)).some((item) => item.label === 'heading'));
    const text = hoverText(await hover(template, position));
    assert.match(text, /TaskController::alternate/);
    assert.match(text, /1 of 2 indexed render sites/);
    assert.match(text, /may omit this variable/);
  });

  test('controller items and hovers stay out of labels, strings, HTML and shadowed locals', async () => {
    for (const marked of [
      '<h1>ta§sks</h1>', '{# {{ ta§sks }} #}', '{{ "ta§sks" }}',
      '{{ item.ta§sks }}', '{{ item|ta§sks }}', '{{ { ta§sks: [] } }}',
      '{% for tasks in [] %}{{ ta§sks }}{% endfor %}',
      '{% set tasks = [] %}{{ ta§sks }}',
      '{% macro list() %}{{ ta§sks }}{% endmacro %}',
    ]) {
      const position = await at(marked);
      assert.ok(!(await completions(template, position)).some((item) => item.label === 'tasks'), marked);
      assert.equal((await hover(template, position)).length, 0, marked);
    }
  });

  test('template-name completion still runs alongside the variable provider', async () => {
    const position = await at("{% include 'ta§sk/index.html.twig' %}");
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider', template.uri, position,
    );
    assert.ok(result?.items.some((item) => item.label === 'task/_row.html.twig'));
    assert.equal((await completions(template, position)).length, 0);
  });

  test('included partials do not borrow controller context from their caller or a nested workspace', async () => {
    const partial = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ROOT, 'templates/task/_row.html.twig')));
    const original = partial.getText();
    try {
      await replace(partial, '{{ tasks }}');
      assert.equal((await completions(partial, new vscode.Position(0, 5))).length, 0);
      assert.equal((await hover(partial, new vscode.Position(0, 5))).length, 0);
    } finally {
      await replace(partial, original);
      await vscode.window.showTextDocument(partial);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  test('wicker.enable disables both providers', async () => {
    const position = await at('{{ ta§sks }}');
    const config = vscode.workspace.getConfiguration('wicker');
    const previous = config.inspect<boolean>('enable')?.workspaceValue;
    try {
      await config.update('enable', false, vscode.ConfigurationTarget.Workspace);
      assert.equal((await completions(template, position)).length, 0);
      assert.equal((await hover(template, position)).length, 0);
    } finally {
      await config.update('enable', previous, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('a nested workspace receives its own context keys', async () => {
    const nested = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ROOT, 'nested-app/templates/task/_row.html.twig')));
    const original = nested.getText();
    try {
      await replace(nested, '{{ nestedOnly }}');
      const items = await completions(nested, new vscode.Position(0, 5));
      assert.deepEqual(items.map((item) => item.label), ['nestedOnly']);
      assert.match(hoverText(await hover(nested, new vscode.Position(0, 5))), /NestedController::index/);
    } finally {
      await replace(nested, original);
      await vscode.window.showTextDocument(nested);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });
});
