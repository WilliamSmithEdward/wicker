import * as vscode from 'vscode';
import { severityFromSettings } from './severity.js';

import {
  callableGroup, findTwigCallable, isConcreteTwigCallable, scanTwigCallables, twigCallableContextAt,
  type TwigCallable,
} from '@wicker/core';

import type { ProjectSession, SessionManager } from './session.js';
import { rangeOf } from './ranges.js';

/** Native Twig expression assistance, using this project's discovered registrations. */
export class TwigCallableProvider implements vscode.CompletionItemProvider, vscode.HoverProvider {
  constructor(private readonly sessions: SessionManager) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const catalog = this.sessions.sessionFor(document)?.loaderPaths.callables;
    if (catalog === undefined) { return undefined; }
    const context = twigCallableContextAt(document.getText(), document.offsetAt(position));
    if (context === undefined) { return undefined; }
    return callableGroup(catalog, context.kind).entries.filter((entry) => isConcreteTwigCallable(entry.name)).map((entry) => {
      const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Function);
      item.detail = `Wicker · Twig ${entry.kind}`;
      item.range = rangeOf(document, context.range);
      // Keep existing parentheses intact. Reflection output is not reliable
      // enough to insert required arguments or infer a Twig signature.
      item.insertText = entry.name;
      item.documentation = documentation(entry, entry.name);
      return item;
    });
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const catalog = this.sessions.sessionFor(document)?.loaderPaths.callables;
    if (catalog === undefined) { return undefined; }
    const offset = document.offsetAt(position);
    const reference = scanTwigCallables(document.getText()).find((item) => offset >= item.range.start && offset < item.range.end);
    if (reference === undefined) { return undefined; }
    const entry = findTwigCallable(catalog, reference.kind, reference.name);
    return entry === undefined ? undefined : new vscode.Hover(documentation(entry, reference.name),
      rangeOf(document, reference.range));
  }
}

export function twigCallableDiagnostics(session: ProjectSession, document: vscode.TextDocument): vscode.Diagnostic[] {
  const catalog = session.loaderPaths.callables;
  if (catalog === undefined || !session.canCheckCallables ||
      (document.languageId !== 'twig' && !document.uri.path.endsWith('.twig'))) { return []; }
  const severity = severityFromSettings('unknownCallable', 'warning', document.uri);
  if (severity === undefined) { return []; }
  return scanTwigCallables(document.getText()).filter((reference) =>
    callableGroup(catalog, reference.kind).complete && findTwigCallable(catalog, reference.kind, reference.name) === undefined,
  ).map((reference) => {
    const diagnostic = new vscode.Diagnostic(
      rangeOf(document, reference.range),
      `Twig ${reference.kind} "${reference.name}" is not registered in this project.`, severity,
    );
    diagnostic.source = 'wicker';
    diagnostic.code = `unknown-twig-${reference.kind}`;
    return diagnostic;
  });
}

function documentation(entry: TwigCallable, name: string): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;
  markdown.appendMarkdown(`**Twig ${entry.kind}**\n\n`);
  markdown.appendText(name);
  markdown.appendMarkdown('\n\nDiscovered in this project');
  if (entry.name !== name) {
    markdown.appendMarkdown(' through ');
    markdown.appendText(entry.name);
  }
  markdown.appendMarkdown('.');
  if (entry.reportedArguments !== undefined && entry.reportedArguments.length > 0) {
    markdown.appendMarkdown('\n\n**Arguments reported by Symfony**\n\n');
    markdown.appendText(entry.reportedArguments.join(', '));
    markdown.appendMarkdown('\n\nThis list can include implicit PHP arguments; it is not a Twig call signature.');
  }
  const link = referenceLink(entry);
  if (link !== undefined) { markdown.appendMarkdown(`\n\n[Official reference](${link})`); }
  return markdown;
}

// Only link documented names. A project's custom registration can override a
// standard name, so these are references rather than claims about its behavior.
const TWIG_FILTERS = new Set('abs batch capitalize column convert_encoding date date_modify default escape filter first format join json_encode keys last length lower map merge nl2br number_format raw reduce replace reverse round slice sort split striptags title trim upper url_encode'.split(' '));
const TWIG_FUNCTIONS = new Set('attribute block constant cycle date enum enum_cases include max min parent random range source'.split(' '));
const SYMFONY_NAMES = new Set('absolute_url asset asset_version controller csrf_token fragment_uri is_granted path relative_path render render_* trans url'.split(' '));

function referenceLink(entry: TwigCallable): string | undefined {
  if ((entry.kind === 'filter' ? TWIG_FILTERS : TWIG_FUNCTIONS).has(entry.name)) {
    return `https://twig.symfony.com/doc/3.x/${entry.kind}s/${entry.name}.html`;
  }
  if (entry.kind === 'filter' && entry.name === 'e') { return 'https://twig.symfony.com/doc/3.x/filters/escape.html'; }
  if (SYMFONY_NAMES.has(entry.name)) { return 'https://symfony.com/doc/current/reference/twig_reference.html'; }
  return undefined;
}
