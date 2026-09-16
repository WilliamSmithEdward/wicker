import * as vscode from 'vscode';

import { anonymousComponentProps, classToProjectPaths, componentClassSource, componentReferenceAt, joinProjectPath,
  type ComponentProp, type ComponentReference, type OffsetRange, type TwigComponent } from '@wicker/core';

import type { ProjectSession, SessionManager } from './session.js';
import { rangeOf } from './ranges.js';

interface Source { readonly document: vscode.TextDocument; readonly path: string }
interface PropSource extends Source { readonly props: readonly ComponentProp[]; readonly range: OffsetRange }

export class TwigComponentProvider implements vscode.CompletionItemProvider, vscode.DefinitionProvider, vscode.HoverProvider {
  constructor(private readonly sessions: SessionManager) {}

  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const session = this.sessions.sessionFor(document);
    const reference = componentReferenceAt(document.getText(), document.offsetAt(position));
    if (!session || !reference) { return undefined; }
    const range = rangeOf(document, reference.range);
    if (reference.kind === 'name') {
      return session.components.components.map((component) => {
        const item = new vscode.CompletionItem(component.name, vscode.CompletionItemKind.Class);
        item.detail = 'Wicker · Twig component';
        item.documentation = documentation(component);
        item.range = range;
        return item;
      });
    }
    const component = session.components.components.find((entry) => entry.name === reference.name);
    if (!component) { return undefined; }
    const version = document.version;
    const source = await this.props(session, component);
    if (!source || !this.current(document, version, session, component)) { return undefined; }
    return source.props.filter((prop) => !reference.usedProps?.includes(prop.name)).map((prop) => {
      const item = new vscode.CompletionItem(prop.name, vscode.CompletionItemKind.Property);
      item.detail = 'Wicker · Component prop';
      item.documentation = propDocumentation(prop, source.path);
      item.range = range;
      item.insertText = reference.hasValue ? prop.name : new vscode.SnippetString().appendText(prop.name).appendText('="').appendTabstop().appendText('"');
      return item;
    });
  }

  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.LocationLink[] | undefined> {
    const session = this.sessions.sessionFor(document);
    const reference = componentReferenceAt(document.getText(), document.offsetAt(position));
    const component = session?.components.components.find((entry) => entry.name === reference?.name);
    if (!session || !reference || !component) { return undefined; }
    const version = document.version;
    const source = await this.props(session, component);
    const links: vscode.LocationLink[] = [];
    if (reference.kind === 'prop') {
      const prop = source?.props.find((entry) => entry.name === reference.prop);
      if (source && prop) { links.push(location(document, reference, source, prop.range)); }
    } else {
      if (source && component.className) { links.push(location(document, reference, source, source.range)); }
      const template = await this.template(session, component);
      if (template) { links.push(location(document, reference, template, { start: 0, end: 0 })); }
    }
    return this.current(document, version, session, component) ? links : undefined;
  }

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const session = this.sessions.sessionFor(document);
    const reference = componentReferenceAt(document.getText(), document.offsetAt(position));
    const component = session?.components.components.find((entry) => entry.name === reference?.name);
    if (!session || !reference || !component) { return undefined; }
    const version = document.version;
    const source = await this.props(session, component);
    const prop = source?.props.find((entry) => entry.name === reference.prop);
    if (!this.current(document, version, session, component) || (reference.kind === 'prop' && !prop)) { return undefined; }
    const content = prop && source ? propDocumentation(prop, source.path) : documentation(component);
    if (reference.kind === 'name' && source && source.props.length > 0) {
      content.appendMarkdown('\n\nProps found in source: ');
      content.appendText(source.props.map((entry) => entry.name).join(', '));
    }
    return new vscode.Hover(content, rangeOf(document, reference.range));
  }

  private current(document: vscode.TextDocument, version: number, session: ProjectSession, component: TwigComponent): boolean {
    return document.version === version && this.sessions.sessionFor(document) === session && session.components.components.includes(component);
  }

  private async source(session: ProjectSession, path: string): Promise<Source | undefined> {
    const uri = session.uriOf(path);
    if (this.sessions.sessionFor({ uri }) !== session) { return undefined; }
    if ((await session.fileSystem.stat(joinProjectPath(session.project.root, path)))?.type !== 'file') { return undefined; }
    try {
      // VS Code returns an existing buffer here, including its unsaved text.
      return { document: await vscode.workspace.openTextDocument(uri), path };
    } catch { return undefined; } // File may disappear between index and query.
  }

  private async template(session: ProjectSession, component: TwigComponent): Promise<Source | undefined> {
    const template = session.lookup(component.template);
    return template ? this.source(session, template.projectPath) : undefined;
  }

  private async props(session: ProjectSession, component: TwigComponent): Promise<PropSource | undefined> {
    if (!component.className) {
      const source = await this.template(session, component);
      return source ? { ...source, range: { start: 0, end: 0 }, props: anonymousComponentProps(source.document.getText()) } : undefined;
    }
    const manifest = session.components.manifest;
    if (!manifest) { return undefined; }
    for (const path of classToProjectPaths(manifest, component.className)) {
      const source = await this.source(session, path);
      if (!source) { continue; }
      const declaration = componentClassSource(source.document.getText(), component.className);
      if (declaration) { return { ...source, ...declaration }; }
    }
    return undefined;
  }
}

function location(document: vscode.TextDocument, reference: ComponentReference, source: Source, range: OffsetRange): vscode.LocationLink {
  const target = rangeOf(source.document, range);
  return { originSelectionRange: rangeOf(document, reference.range), targetUri: source.document.uri,
    targetRange: target, targetSelectionRange: target };
}

function documentation(component: TwigComponent): vscode.MarkdownString {
  const content = new vscode.MarkdownString();
  content.isTrusted = false;
  content.appendMarkdown('**Twig component**\n\n');
  content.appendText(component.name);
  content.appendMarkdown('\n\n');
  content.appendText(component.className ? `Class: ${component.className}` : 'Anonymous component');
  content.appendMarkdown('\n\n');
  content.appendText(`Template: ${component.template}`);
  if (component.live) { content.appendMarkdown('\n\nLive Component'); }
  content.appendMarkdown('\n\nRegistered by Symfony. Use Go to Definition to open its source.');
  return content;
}

function propDocumentation(prop: ComponentProp, path: string): vscode.MarkdownString {
  const content = new vscode.MarkdownString();
  content.isTrusted = false;
  content.appendMarkdown('**Component prop**\n\n');
  content.appendText(`${prop.name}: ${prop.kind === 'props' ? 'Twig props declaration' : prop.kind}`);
  content.appendMarkdown('\n\n');
  content.appendText(path);
  return content;
}
