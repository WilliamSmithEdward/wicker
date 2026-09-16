import * as vscode from 'vscode';

import { classToProjectPaths, liveComponentSource, liveReferences,
  type LiveComponentSource, type LiveMember, type LiveReference, type TwigComponent } from '@wicker/core';

import { frontendIndex } from './frontendProject.js';
import { enginePathOf } from './paths.js';
import { rangeInSource, rangeOf } from './ranges.js';
import type { ProjectSession, SessionManager } from './session.js';
import { severityFromSettings } from './severity.js';

/** A live component's template, the class behind it, and what that class declares. */
interface Live {
  readonly session: ProjectSession;
  readonly component: TwigComponent;
  readonly classPath: string;
  readonly classSource: string;
  readonly declared: LiveComponentSource;
}

/**
 * Live Components, read from the template side.
 *
 * `data-model` binds a prop and `live_action()` names a method, and the
 * class decides which of each the template may reach: only a prop marked
 * writable takes a change, only a method marked as an action answers a call.
 * A name that misses is refused at runtime and reported nowhere, so here the
 * names complete from the class, say what they are, open their declaration,
 * and are checked.
 */
export class LiveComponentProvider implements vscode.CompletionItemProvider, vscode.HoverProvider, vscode.DefinitionProvider {
  constructor(private readonly sessions: SessionManager) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const live = liveOf(this.sessions, document);
    if (live === undefined) { return undefined; }
    const offset = document.offsetAt(position);
    const before = document.getText().slice(Math.max(0, offset - 200), offset);
    const model = /\bdata-model\s*=\s*["'](?:[^"'|{}]*\|)*([A-Za-z_]\w*)?$/.exec(before);
    const action = model ? null : /(?:\blive_action\(\s*|\bdata-live-action-param\s*=\s*)["']([A-Za-z_]\w*)?$/.exec(before);
    if (!model && !action) { return undefined; }
    const kind: LiveReference['kind'] = model ? 'model' : 'action';
    const typed = (model ?? action)?.[1] ?? '';
    const members = kind === 'model' ? live.declared.props.filter((prop) => prop.writable) : live.declared.actions;
    return members.map((member) => {
      const item = new vscode.CompletionItem(member.name, kind === 'model' ? vscode.CompletionItemKind.Property : vscode.CompletionItemKind.Method);
      item.detail = kind === 'model' ? 'Wicker · Live prop' : 'Wicker · Live action';
      item.documentation = explain(live, kind, member);
      item.range = new vscode.Range(document.positionAt(offset - typed.length), position);
      return item;
    });
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const at = this.locate(document, position);
    if (at === undefined) { return undefined; }
    const content = new vscode.MarkdownString();
    content.isTrusted = false;
    content.appendText(at.member === undefined ? missing(at.live, at.reference) : explain(at.live, at.reference.kind, at.member));
    return new vscode.Hover(content, rangeOf(document, at.reference.range));
  }

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.LocationLink[] | undefined {
    const at = this.locate(document, position);
    if (at?.member === undefined) { return undefined; }
    return [{ originSelectionRange: rangeOf(document, at.reference.range), targetUri: at.live.session.uriOf(at.live.classPath),
      targetRange: rangeInSource(at.live.classSource, at.member.range), targetSelectionRange: rangeInSource(at.live.classSource, at.member.range) }];
  }

  private locate(document: vscode.TextDocument, position: vscode.Position):
  { live: Live; reference: LiveReference; member: LiveMember | undefined } | undefined {
    const live = liveOf(this.sessions, document);
    if (live === undefined) { return undefined; }
    const offset = document.offsetAt(position);
    const reference = liveReferences(document.getText()).find((entry) => offset >= entry.range.start && offset <= entry.range.end);
    return reference === undefined ? undefined : { live, reference, member: memberFor(live, reference) };
  }
}

/**
 * Reports a binding the class cannot serve.
 *
 * A prop or action the class does not declare, and a `data-model` on a prop
 * that is not writable, are refused when the request arrives and say nothing
 * in the editor. Suspended while the component list is being rebuilt.
 */
export function liveComponentDiagnostics(sessions: SessionManager, session: ProjectSession, document: vscode.TextDocument): vscode.Diagnostic[] {
  const severity = severityFromSettings('unknownLiveMember', 'warning');
  if (severity === undefined || !session.discoveryCurrent) { return []; }
  const live = liveOf(sessions, document);
  if (live === undefined) { return []; }
  const result: vscode.Diagnostic[] = [];
  for (const reference of liveReferences(document.getText())) {
    const member = memberFor(live, reference);
    const message = member === undefined ? missing(live, reference)
      : reference.kind === 'model' && !member.writable ? notWritable(live, reference.name) : undefined;
    if (message === undefined) { continue; }
    const diagnostic = new vscode.Diagnostic(rangeOf(document, reference.range), message, severity);
    diagnostic.source = 'wicker';
    diagnostic.code = member === undefined ? 'unknown-live-member' : 'readonly-live-prop';
    result.push(diagnostic);
  }
  return sessions.sessionFor(document) === session ? result : [];
}

/** The live component a template belongs to, with its class read from the index, which holds open buffers too. */
function liveOf(sessions: SessionManager, document: vscode.TextDocument): Live | undefined {
  const session = sessions.sessionFor(document);
  const path = session?.relativePathOf(enginePathOf(document.uri));
  if (!session || path === undefined || !path.endsWith('.twig')) { return undefined; }
  const names = session.index.namesForProjectPath(path);
  const component = session.components.components.find((entry) => entry.live && entry.className !== undefined && names.includes(entry.template));
  const manifest = session.components.manifest;
  if (component?.className === undefined || manifest === undefined) { return undefined; }
  const index = frontendIndex(sessions, session);
  for (const classPath of classToProjectPaths(manifest, component.className)) {
    const classSource = index.get(classPath)?.source;
    if (classSource === undefined) { continue; }
    return { session, component, classPath, classSource, declared: liveComponentSource(classSource) };
  }
  return undefined;
}

function memberFor(live: Live, reference: LiveReference): LiveMember | undefined {
  return (reference.kind === 'model' ? live.declared.props : live.declared.actions).find((entry) => entry.name === reference.name);
}

function explain(live: Live, kind: LiveReference['kind'], member: LiveMember): string {
  const file = live.classPath.slice(live.classPath.lastIndexOf('/') + 1);
  if (kind === 'action') { return `Live action ${member.name}() in ${file}: a request calls it on ${live.component.name}.`; }
  return member.writable
    ? `Live prop $${member.name} in ${file}, writable: a change here is sent to ${live.component.name} and re-renders it.`
    : notWritable(live, member.name);
}

function missing(live: Live, reference: LiveReference): string {
  return reference.kind === 'model'
    ? `${live.component.name} declares no LiveProp named "${reference.name}", so this binding does nothing.`
    : `${live.component.name} declares no LiveAction named "${reference.name}", so the request is refused.`;
}

function notWritable(live: Live, name: string): string {
  return `${live.component.name}'s "${name}" is not writable, so a change from this binding is refused. Mark it #[LiveProp(writable: true)] to accept one.`;
}
