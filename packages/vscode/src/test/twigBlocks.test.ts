import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { definitionsAt, replace, until } from './support.js';

const ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');
const uri = (...segments: string[]): vscode.Uri => vscode.Uri.file(path.join(ROOT, ...segments));

/** The position just inside a word, at its first occurrence or at its occurrence inside `context`. */
function at(document: vscode.TextDocument, needle: string, context = needle): vscode.Position {
  const start = document.getText().indexOf(context);
  assert.ok(start >= 0, `${context} should be in ${document.uri.path}`);
  return document.positionAt(start + context.indexOf(needle) + 1);
}

async function hoverText(document: vscode.TextDocument, position: vscode.Position): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position);
  return hovers.flatMap((hover) => hover.contents).map((content) => typeof content === 'string' ? content : content.value)
    .join('\n').replaceAll('\\', '').replaceAll('&nbsp;', ' ');
}

const unknownBlocks = (document: vscode.TextDocument): vscode.Diagnostic[] =>
  vscode.languages.getDiagnostics(document.uri).filter((entry) => entry.code === 'unknown-block');

suite('Twig blocks', () => {
  const childUri = uri('templates', 'task', 'blocks_test.html.twig');
  const childSource = `{% extends 'base.html.twig' %}\n{% block title %}{{ parent() }} tasks{% endblock %}\n{% block bdy %}{% endblock %}\n`;
  let child: vscode.TextDocument;
  let layout: vscode.TextDocument;

  suiteSetup(async () => {
    await vscode.extensions.getExtension('WilliamSmithE.wicker')!.activate();
    await vscode.workspace.fs.writeFile(childUri, Buffer.from(childSource));
    child = await vscode.workspace.openTextDocument(childUri);
    layout = await vscode.workspace.openTextDocument(uri('templates', 'base.html.twig'));
    await until(() => unknownBlocks(child).length === 1, 'the misspelt block should be reported once the file is read');
  });

  suiteTeardown(async () => {
    await vscode.window.showTextDocument(child);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.workspace.fs.delete(childUri);
  });

  test('goes up to the block a child overrides, and down from a layout to its overrides', async () => {
    // Definition on the name, and on parent() inside the block, both reach the layout.
    for (const needle of ['title', 'parent']) {
      const links = (await definitionsAt(child, at(child, needle))).filter((link): link is vscode.LocationLink => 'targetUri' in link);
      assert.equal(links.length, 1, `${needle} should have one definition`);
      assert.ok(links[0]!.targetUri.path.endsWith('/templates/base.html.twig'));
      assert.equal(layout.getText(links[0]!.targetSelectionRange), 'title');
    }
    assert.match(await hoverText(child, at(child, 'title')), /Overrides \{% block title %\} in base\.html\.twig\./);
    // A block no ancestor defines is said so on hover, in the same words as the diagnostic.
    assert.match(await hoverText(child, at(child, 'bdy')), /No ancestor of this template defines a block named "bdy"/);

    // From the layout, the block is found in every template overriding it.
    const references = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider', layout.uri, at(layout, 'body', 'block body'));
    assert.ok(references.some((location) => location.uri.path.endsWith('/templates/task/index.html.twig')),
      `expected the override in task/index.html.twig, got ${references.map((location) => location.uri.path).join(', ')}`);
    assert.match(await hoverText(layout, at(layout, 'body', 'block body')), /Overridden in [^.]*task\/index\.html\.twig/);
  });

  test('completes the names the layout declares, and reports a block it never renders', async () => {
    const blockNames = async (source: string): Promise<string[]> => {
      await replace(child, source);
      const position = child.positionAt(source.length);
      const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', child.uri, position);
      return list.items.filter((item) => item.detail === 'Wicker · Twig block')
        .map((item) => typeof item.label === 'string' ? item.label : item.label.label).sort();
    };
    try {
      assert.deepEqual(await blockNames(`{% extends 'base.html.twig' %}\n{% block `), ['body', 'title']);
      // A block this template already overrides is not offered again.
      assert.deepEqual(await blockNames(`{% extends 'base.html.twig' %}\n{% block title %}{% endblock %}\n{% block b`), ['body']);
      // Inside an embed the names come from the embedded template, not the layout.
      assert.deepEqual(await blockNames(`{% extends 'base.html.twig' %}\n{% embed 'task/_row.html.twig' %}{% block `), []);

      await replace(child, childSource);
      await until(() => unknownBlocks(child).length === 1, 'the misspelt block should be reported again');
      assert.match(unknownBlocks(child)[0]!.message, /Block "bdy" is defined by no ancestor of this template, so Twig never renders it\./);
      // A real override, a block inside an embed, and a layout named at
      // runtime are not reported.
      await replace(child, `{% extends 'base.html.twig' %}\n{% block body %}{% endblock %}\n{% embed 'task/_row.html.twig' %}{% block anything %}{% endblock %}{% endembed %}\n`);
      await until(() => unknownBlocks(child).length === 0, 'an override and an embedded block are fine');
      await replace(child, `{% extends layout %}\n{% block bdy %}{% endblock %}\n`);
      await until(() => unknownBlocks(child).length === 0, 'a runtime layout cannot be checked');
    } finally {
      await replace(child, childSource);
    }
  });
});
