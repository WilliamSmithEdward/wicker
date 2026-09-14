import { scanFrontend, stimulusSource, type FrontendReference, type StimulusSource } from '@wicker/core';
import * as vscode from 'vscode';

import { ownsFrontendPath } from './frontendProject.js';
import { enginePathOf } from './paths.js';
import type { ProjectSession, SessionManager } from './session.js';

/**
 * Offers to write the member a template is already asking for.
 *
 * A binding names a method or a declaration that has to exist in the
 * controller, and when it does not the page simply does nothing: Stimulus
 * attaches no listener and reports nothing. Everything needed to fix it is
 * known here, the controller file, its class body and what the member should
 * be called, so the edit is offered rather than described.
 *
 * Only a missing member is offered. A binding that already resolves needs no
 * action, and a controller that is not registered has no file to write to.
 */
export class StimulusMemberActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly sessions: SessionManager) {}

  async provideCodeActions(document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection): Promise<vscode.CodeAction[]> {
    const session = this.sessions.sessionFor(document);
    const path = session?.relativePathOf(enginePathOf(document.uri));
    if (!session || !path?.endsWith('.twig')) { return []; }

    const offset = document.offsetAt(range.start);
    const reference = scanFrontend(document.getText(), true).references.find((entry) =>
      offset >= entry.range.start && offset <= entry.range.end);
    if (!reference || !ADDABLE.includes(reference.kind) || reference.name.length === 0) { return []; }

    const controller = session.frontend.controllers.find((entry) => entry.name === reference.controller);
    if (!controller || !ownsFrontendPath(this.sessions, session, controller.projectPath)) { return []; }

    const uri = session.fileSystem.toUri(joinPath(session, controller.projectPath));
    let source: vscode.TextDocument;
    try { source = await vscode.workspace.openTextDocument(uri); }
    catch { return []; }

    const info = stimulusSource(source.getText());
    if (info.bodyRange === undefined || alreadyDeclared(info, reference)) { return []; }

    const edit = edited(source, info, reference);
    if (!edit) { return []; }

    const action = new vscode.CodeAction(edit.title, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(uri, source.positionAt(edit.offset), edit.text);
    action.isPreferred = true;
    // Opening the file is part of the fix: an edit applied out of sight is
    // hard to trust and hard to undo deliberately.
    action.command = { command: 'vscode.open', title: 'Open the controller', arguments: [uri] };
    return [action];
  }
}

const ADDABLE: readonly FrontendReference['kind'][] = ['action', 'target', 'value', 'class'];

function alreadyDeclared(info: StimulusSource, reference: FrontendReference): boolean {
  const declared = reference.kind === 'action' ? info.actions
    : reference.kind === 'target' ? info.targets
      : reference.kind === 'value' ? info.values : info.classes;
  return declared.some((member) => member.name === reference.name);
}

/**
 * Where to write, and what.
 *
 * A method goes just inside the closing brace. A declaration joins its static
 * list when one exists, and starts one at the top of the body when it does
 * not, which is where every Stimulus controller keeps them.
 */
function edited(document: vscode.TextDocument, info: StimulusSource, reference: FrontendReference):
{ title: string; offset: number; text: string } | undefined {
  const body = info.bodyRange!;
  const indent = indentOf(document.getText(), body.start);

  if (reference.kind === 'action') {
    return {
      title: `Add ${reference.name}() to this controller`,
      offset: body.end - 1,
      text: `\n${indent}${reference.name}(event) {\n${indent}${indent}\n${indent}}\n`,
    };
  }

  const list = reference.kind === 'target' ? info.targets
    : reference.kind === 'value' ? info.values : info.classes;
  const entry = reference.kind === 'value' ? `${reference.name}: String` : `'${reference.name}'`;

  const last = list.at(-1);
  if (last) {
    return { title: `Add ${reference.name} to static ${plural(reference.kind)}`,
      offset: last.range.end + 1, text: `, ${entry}` };
  }

  const brackets = reference.kind === 'value' ? ['{ ', ' }'] : ['[', ']'];
  return {
    title: `Declare static ${plural(reference.kind)} with ${reference.name}`,
    offset: body.start + 1,
    text: `\n${indent}static ${plural(reference.kind)} = ${brackets[0]}${entry}${brackets[1]};\n`,
  };
}

function plural(kind: FrontendReference['kind']): string {
  return kind === 'class' ? 'classes' : `${kind}s`;
}

/** The indentation the file already uses, so an inserted member matches it. */
function indentOf(source: string, bodyStart: number): string {
  const after = source.slice(bodyStart + 1);
  const match = /\n([ \t]+)\S/.exec(after);
  return match?.[1] ?? '  ';
}

function joinPath(session: ProjectSession, projectPath: string): string {
  return `${session.project.root.replace(/\/$/, '')}/${projectPath}`;
}
