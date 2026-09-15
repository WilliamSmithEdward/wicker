import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { LoaderPathMemory } from '../loaderPathMemory.js';
import { SessionManager } from '../session.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures/symfony-app');

/** A file in the fixture project, by project-relative path. */
export function fixture(file: string): vscode.Uri {
  return vscode.Uri.file(path.join(FIXTURE_ROOT, file));
}

/** Replaces a document's whole text through a workspace edit, unsaved. */
export async function replace(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

/**
 * Polls until the check holds, failing with the suite's own message.
 *
 * The message says what was expected to catch up, which is the one thing a
 * timeout needs to say; the loop underneath is the same in every suite.
 */
export async function until(check: () => Promise<boolean> | boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Every completion item offered at a position, unfiltered. */
export async function completionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, position);
  return list?.items ?? [];
}

/** Every definition offered at a position, in whichever shape the provider gave. */
export async function definitionsAt(document: vscode.TextDocument, position: vscode.Position): Promise<(vscode.Location | vscode.LocationLink)[]> {
  return (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider', document.uri, position)) ?? [];
}

export function tooltipOf(item: vscode.TreeItem): string {
  return typeof item.tooltip === 'string' ? item.tooltip : item.tooltip?.value ?? '';
}

/**
 * A session manager whose remembered namespaces live in this process only.
 *
 * The real one remembers console answers in workspace state, which would
 * carry one test's answers into the next. Backing it with a map gives each
 * caller its own memory, and the map is owned here because no test reads it
 * back: what they check is what the sessions do with it.
 */
export function memorySessions(): SessionManager {
  const memory = new Map<string, unknown>();
  return new SessionManager(new LoaderPathMemory({
    keys: () => [...memory.keys()],
    get: <T>(key: string, fallback?: T): T | undefined => (memory.get(key) as T | undefined) ?? fallback,
    update: (key, value) => { memory.set(key, value); return Promise.resolve(); },
  }));
}
