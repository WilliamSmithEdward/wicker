import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { completionItems, definitionsAt, fixture, replace, until } from './support.js';

const PHP = 'src/Twig/Components/Counter.php';
const TWIG = 'templates/components/Counter.html.twig';
const phpSource = `<?php

namespace App\\Twig\\Components;

use Symfony\\UX\\LiveComponent\\Attribute\\AsLiveComponent;
use Symfony\\UX\\LiveComponent\\Attribute\\LiveAction;
use Symfony\\UX\\LiveComponent\\Attribute\\LiveProp;
use Symfony\\UX\\LiveComponent\\DefaultActionTrait;

#[AsLiveComponent('Counter')]
final class Counter
{
    use DefaultActionTrait;

    #[LiveProp(writable: true)]
    public int $count = 0;

    #[LiveProp]
    public string $label = '';

    #[LiveAction]
    public function increment(): void
    {
        $this->count++;
    }

    public function helper(): void
    {
    }
}
`;
const twigSource = `<div {{ attributes }}>
  <input data-model="count">
  <button {{ live_action('increment') }}>+</button>
</div>
`;
// The console reports the component as live; the class itself is read from the file.
const CONSOLE = `if (!process.argv.includes('debug:twig-component')) {
  process.stdout.write(JSON.stringify({loader_paths: {'(None)': ['templates']}, filters: {}, functions: {component: [], live_action: []}}));
} else {
  process.stdout.write('| Name | Class | Template | Type |\\n| Alert | App\\\\Twig\\\\Components\\\\Alert | components/Alert.html.twig | |\\n| Counter | App\\\\Twig\\\\Components\\\\Counter | components/Counter.html.twig | Live |\\n');
}`;

const uri = fixture;
const liveProblems = (document: vscode.TextDocument): vscode.Diagnostic[] => vscode.languages.getDiagnostics(document.uri)
  .filter((entry) => entry.code === 'unknown-live-member' || entry.code === 'readonly-live-prop');

suite('Live Components', () => {
  const settings = vscode.workspace.getConfiguration('wicker');
  let previousCommand: string[] | undefined, previousConsole: boolean | undefined;
  let twig: vscode.TextDocument, php: vscode.TextDocument;

  async function at(marked: string): Promise<vscode.Position> {
    const offset = marked.indexOf('§');
    assert.ok(offset >= 0);
    await replace(twig, marked.replace('§', ''));
    return twig.positionAt(offset);
  }
  async function labels(marked: string, detail: string): Promise<string[]> {
    const position = await at(marked);
    return (await completionItems(twig, position)).filter((item) => item.detail === detail)
      .map((item) => typeof item.label === 'string' ? item.label : item.label.label).sort();
  }
  async function hoverText(marked: string): Promise<string> {
    const position = await at(marked);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', twig.uri, position);
    return hovers.flatMap((hover) => hover.contents).map((content) => typeof content === 'string' ? content : content.value)
      .join('\n').replaceAll('\\', '').replaceAll('&nbsp;', ' ');
  }

  suiteSetup(async () => {
    await vscode.extensions.getExtension('WilliamSmithE.wicker')!.activate();
    previousCommand = settings.inspect<string[]>('console.command')?.workspaceValue;
    previousConsole = settings.inspect<boolean>('console.enabled')?.workspaceValue;
    await vscode.workspace.fs.writeFile(uri(PHP), Buffer.from(phpSource));
    await vscode.workspace.fs.writeFile(uri(TWIG), Buffer.from(twigSource));
    await settings.update('console.command', [process.env['npm_node_execpath'] ?? 'node', '-e', CONSOLE, '--'], vscode.ConfigurationTarget.Workspace);
    await settings.update('console.enabled', true, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('wicker.reindex');
    twig = await vscode.workspace.openTextDocument(uri(TWIG));
    php = await vscode.workspace.openTextDocument(uri(PHP));
  });

  suiteTeardown(async () => {
    for (const document of [twig, php]) {
      if (!document) { continue; }
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.workspace.fs.delete(document.uri);
    }
    await settings.update('console.command', previousCommand, vscode.ConfigurationTarget.Workspace);
    await settings.update('console.enabled', previousConsole, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('wicker.reindex');
  });

  test('completes writable props and actions, explains them, and opens their declarations', async () => {
    await until(async () => (await labels(`<input data-model="§">`, 'Wicker · Live prop')).length > 0, 'the component class should be read');
    // Only a writable prop can take a change, so only that one is offered.
    assert.deepEqual(await labels(`<input data-model="§">`, 'Wicker · Live prop'), ['count']);
    assert.deepEqual(await labels(`<input data-model="on(change)|debounce(300)|co§">`, 'Wicker · Live prop'), ['count']);
    assert.deepEqual(await labels(`<button {{ live_action('§') }}>`, 'Wicker · Live action'), ['increment']);
    assert.deepEqual(await labels(`<button data-live-action-param="§">`, 'Wicker · Live action'), ['increment']);

    assert.match(await hoverText(`<input data-model="co§unt">`), /Live prop \$count in Counter\.php, writable/);
    assert.match(await hoverText(`<input data-model="la§bel">`), /"label" is not writable/);
    assert.match(await hoverText(`{{ live_action('incr§ement') }}`), /Live action increment\(\) in Counter\.php/);
    assert.match(await hoverText(`{{ live_action('no§pe') }}`), /declares no LiveAction named "nope"/);

    const links = (await definitionsAt(twig, await at(`<input data-model="co§unt">`)))
      .filter((link): link is vscode.LocationLink => 'targetUri' in link);
    assert.equal(links.length, 1);
    assert.ok(links[0]!.targetUri.path.endsWith('/Counter.php'));
    assert.equal(php.getText(links[0]!.targetSelectionRange), 'count');
  });

  test('reports a binding the class cannot serve', async () => {
    await replace(twig, `<input data-model="cnt"><input data-model="label">{{ live_action('nope') }}`);
    await until(() => liveProblems(twig).length === 3, 'two unknown names and a read-only prop should be reported');
    const messages = liveProblems(twig).map((entry) => entry.message);
    assert.ok(messages.some((message) => message.includes('declares no LiveProp named "cnt"')), messages.join('\n'));
    assert.ok(messages.some((message) => message.includes('"label" is not writable')), messages.join('\n'));
    assert.ok(messages.some((message) => message.includes('declares no LiveAction named "nope"')), messages.join('\n'));
    await replace(twig, twigSource);
    await until(() => liveProblems(twig).length === 0, 'bindings the class serves are not reported');
  });
});
