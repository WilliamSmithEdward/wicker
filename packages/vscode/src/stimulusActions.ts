import { resolveOutletReference, stimulusSource, type FrontendReference, type OffsetRange, type StimulusController, type StimulusSource } from '@wicker/core';
import * as vscode from 'vscode';

import { scanOf } from './frontendProject.js';
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
 * action, and a controller that is not registered has no file to write to,
 * so it is offered a file instead. A controller that is registered is offered
 * a connection to another one, through an outlet.
 */
export class StimulusMemberActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite],
  };

  constructor(private readonly sessions: SessionManager) {}

  async provideCodeActions(document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection): Promise<vscode.CodeAction[]> {
    const session = this.sessions.sessionFor(document);
    const path = session?.relativePathOf(enginePathOf(document.uri));
    if (!session || !path?.endsWith('.twig')) { return []; }

    const offset = document.offsetAt(range.start);
    const found = scanOf(session, path, document.getText(), true).references.find((entry) =>
      offset >= entry.range.start && offset <= entry.range.end);
    if (!found || !ADDABLE.includes(found.kind) || found.name.length === 0) { return []; }

    const controllers = session.frontend.controllers.filter((entry) => this.sessions.owns(session, entry.projectPath));
    if (found.kind === 'controller') {
      return controllers.some((entry) => entry.name === found.name)
        ? connectAction(document, found)
        : createController(session, controllers, found.name);
    }

    // An outlet attribute names its controller only as a prefix of its own name.
    const reference = found.kind === 'outlet' ? resolveOutletReference(found, controllers) : found;
    const controller = reference && controllers.find((entry) => entry.name === reference.controller);
    if (!reference || !controller) { return []; }

    const uri = session.uriOf(controller.projectPath);
    let source: vscode.TextDocument;
    try { source = await vscode.workspace.openTextDocument(uri); }
    catch { return []; }

    const info = stimulusSource(source.getText());
    if (info.bodyRange === undefined || alreadyDeclared(info, reference)) { return []; }

    const edit = edited(source, info, reference);
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

/**
 * Connects the controller on an element to another through an outlet: the
 * declaration in the controller and the binding on the element, in one edit.
 *
 * The selector written is the general one, matching every element the other
 * controller is attached to. Narrowing it is a decision about the page that
 * only its author can make, so it is left in view to be edited. Without a
 * peer the choice is asked for; a caller that knows it passes it.
 */
export async function connectOutlet(sessions: SessionManager, uri: vscode.Uri, offset: number, name: string,
  peer?: string): Promise<boolean> {
  const document = await vscode.workspace.openTextDocument(uri);
  const session = sessions.sessionFor(document);
  const path = session?.relativePathOf(enginePathOf(document.uri));
  if (!session || path === undefined) { return false; }

  const controllers = session.frontend.controllers.filter((entry) => sessions.owns(session, entry.projectPath));
  const controller = controllers.find((entry) => entry.name === name);
  const source = document.getText();
  const found = scanOf(session, path, source, true).references.find((entry) =>
    entry.kind === 'controller' && entry.name === name && offset >= entry.range.start && offset <= entry.range.end);
  const end = found === undefined ? undefined : attributeEnd(source, found.range);
  if (!controller || found === undefined || end === undefined) { return false; }

  const chosen = peer ?? (await vscode.window.showQuickPick(
    controllers.filter((entry) => entry.name !== name).map((entry) => ({ label: entry.name, description: entry.projectPath })),
    { placeHolder: `Controller to reach from ${name} through an outlet` }))?.label;
  if (chosen === undefined || chosen === name || !controllers.some((entry) => entry.name === chosen)) { return false; }

  const edit = new vscode.WorkspaceEdit();
  const attribute = `data-${name}-${chosen}-outlet`;
  // The tag this element opens with, so a binding already there is not written twice.
  const tagEnd = source.indexOf('>', end);
  const tag = source.slice(Math.max(0, source.lastIndexOf('<', found.range.start)), tagEnd === -1 ? undefined : tagEnd + 1);
  if (!tag.includes(`${attribute}=`)) {
    edit.insert(uri, document.positionAt(end), ` ${attribute}="[data-controller~='${chosen}']"`);
  }

  const controllerUri = session.uriOf(controller.projectPath);
  const controllerDocument = await vscode.workspace.openTextDocument(controllerUri);
  const info = stimulusSource(controllerDocument.getText());
  if (info.bodyRange !== undefined && !info.outlets.some((outlet) => outlet.name === chosen)) {
    const declaration = edited(controllerDocument, info, { kind: 'outlet', name: chosen, controller: name, range: found.range });
    edit.insert(controllerUri, controllerDocument.positionAt(declaration.offset), declaration.text);
  }

  if (!await vscode.workspace.applyEdit(edit)) { return false; }
  // Beside, so the binding just written stays in view next to its declaration.
  await vscode.window.showTextDocument(controllerDocument, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  return true;
}

/**
 * Offers to create a controller a template binds but nothing registers.
 *
 * Stimulus names the file from the identifier, so where it belongs is not a
 * guess: the configured controller directory, and `user-card` becomes
 * `user_card_controller.js`. Without the console that directory is unknown,
 * and inventing one would create a file Stimulus never loads. The file is
 * TypeScript when every controller the project has is, so it matches them.
 */
function createController(session: ProjectSession, controllers: readonly StimulusController[], name: string): vscode.CodeAction[] {
  const directory = session.frontend.controllerDirectory;
  if (directory === undefined || !IDENTIFIER.test(name)) { return []; }

  const typescript = controllers.length > 0 && controllers.every((entry) => entry.projectPath.endsWith('.ts'));
  const projectPath = `${directory}/${name.replaceAll('--', '/').replaceAll('-', '_')}_controller.${typescript ? 'ts' : 'js'}`;
  const uri = session.uriOf(projectPath);

  const action = new vscode.CodeAction(`Create ${projectPath}`, vscode.CodeActionKind.QuickFix);
  action.edit = new vscode.WorkspaceEdit();
  action.edit.createFile(uri, { ignoreIfExists: true });
  action.edit.insert(uri, new vscode.Position(0, 0), CONTROLLER_SCAFFOLD);
  action.isPreferred = true;
  action.command = { command: 'vscode.open', title: 'Open the new controller', arguments: [uri] };
  return [action];
}

/**
 * Offers to reach another controller from this element through an outlet.
 *
 * Only where the controller is written as an attribute: the edit adds a
 * sibling attribute, and a `stimulus_controller()` call takes its outlets as
 * an argument this does not rewrite.
 */
function connectAction(document: vscode.TextDocument, found: FrontendReference): vscode.CodeAction[] {
  if (attributeEnd(document.getText(), found.range) === undefined) { return []; }
  const action = new vscode.CodeAction(`Connect ${found.name} to another controller through an outlet...`,
    vscode.CodeActionKind.RefactorRewrite);
  action.command = { command: 'wicker.connectOutlet', title: 'Connect through an outlet',
    arguments: [document.uri, found.range.start, found.name] };
  return [action];
}

/**
 * The offset just past the closing quote of the `data-controller` attribute
 * holding a reference, or nothing when the reference is written elsewhere.
 */
function attributeEnd(source: string, range: OffsetRange): number | undefined {
  const opening = /data-controller\s*=\s*(["'])[^"']*$/.exec(source.slice(Math.max(0, range.start - 200), range.start));
  if (opening === null) { return undefined; }
  const closing = source.indexOf(opening[1] ?? '"', range.end);
  return closing === -1 ? undefined : closing + 1;
}

const CONTROLLER_SCAFFOLD = `import { Controller } from '@hotwired/stimulus';

export default class extends Controller {
    connect() {
    }
}
`;

const ADDABLE: readonly FrontendReference['kind'][] = ['controller', 'action', 'target', 'value', 'class', 'outlet'];

/** Identifier characters StimulusBundle maps back to a file name. */
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

function alreadyDeclared(info: StimulusSource, reference: FrontendReference): boolean {
  return (reference.kind === 'action' ? info.actions : declared(info, reference.kind))
    .some((member) => member.name === reference.name);
}

/** The static list a declaration of this kind joins. */
function declared(info: StimulusSource, kind: FrontendReference['kind']): readonly { readonly name: string; readonly range: OffsetRange }[] {
  return kind === 'target' ? info.targets : kind === 'value' ? info.values : kind === 'outlet' ? info.outlets : info.classes;
}

/**
 * Where to write, and what.
 *
 * A method goes just inside the closing brace, with a typed parameter when
 * the file is TypeScript. A declaration joins its static list when one
 * exists, and starts one at the top of the body when it does not, which is
 * where every Stimulus controller keeps them.
 */
function edited(document: vscode.TextDocument, info: StimulusSource, reference: FrontendReference):
{ title: string; offset: number; text: string } {
  const body = info.bodyRange!;
  const indent = indentOf(document.getText(), body.start);

  if (reference.kind === 'action') {
    const parameter = document.uri.path.endsWith('.ts') ? 'event: Event' : 'event';
    return {
      title: `Add ${reference.name}() to this controller`,
      offset: body.end - 1,
      text: `\n${indent}${reference.name}(${parameter}) {\n${indent}${indent}\n${indent}}\n`,
    };
  }

  const entry = reference.kind === 'value' ? `${reference.name}: String` : `'${reference.name}'`;
  const last = declared(info, reference.kind).at(-1);
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
