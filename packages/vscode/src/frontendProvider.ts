import * as vscode from 'vscode';
import { fetchValueReferences, joinProjectPath, responseAccessAt, scanFrontend, stimulusHtmlName, stimulusSource,
  type FrontendReference, type OffsetRange, type ResponseField, type SymfonyRoute } from '@wicker/core';
import { enginePathOf } from './paths.js';
import type { ProjectSession, SessionManager } from './session.js';
import { frontendIndex, ownsFrontendPath, routeAction, routeConsumers } from './frontendProject.js';
import { OutletQueries } from './outletQueries.js';
import type { FrontendTarget as Target, FrontendCandidate as Candidate, FrontendQuery as Query } from './frontendQueries.js';

export class FrontendProvider implements vscode.CompletionItemProvider, vscode.DefinitionProvider, vscode.HoverProvider, vscode.ReferenceProvider {
  private readonly outlets: OutletQueries;
  constructor(private readonly sessions: SessionManager) { this.outlets = new OutletQueries(sessions); }

  async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const query = await this.query(document, position);
    return query && [...new Map(query.candidates.map((candidate) => [candidate.name, candidate])).values()].map((candidate) => {
      const item = new vscode.CompletionItem(candidate.name, candidate.kind);
      item.range = rangeOf(document, query.range);
      item.detail = candidate.label;
      if (candidate.documentation) { item.documentation = outletDocumentation(candidate.documentation); }
      return item;
    });
  }
  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.LocationLink[] | undefined> {
    const session = this.sessions.sessionFor(document), version = document.version;
    if (!session) { return undefined; }
    const query = await this.query(document, position);
    if (!query) { return undefined; }
    const matches = [...query.candidates.filter((candidate) => candidate.name === query.name), ...query.targets ?? []];
    const links: vscode.LocationLink[] = [];
    for (const target of matches) {
      const uri = session.fileSystem.toUri(joinProjectPath(session.project.root, target.projectPath));
      if (!ownsFrontendPath(this.sessions, session, target.projectPath)) { continue; }
      try {
        const targetDoc = await vscode.workspace.openTextDocument(uri);
        links.push({ originSelectionRange: rangeOf(document, query.range), targetUri: uri,
          targetRange: rangeOf(targetDoc, target.range), targetSelectionRange: rangeOf(targetDoc, target.range) });
      } catch { /* A source deleted during navigation is no longer a target. */ }
    }
    return this.sessions.sessionFor(document) === session && document.version === version ? links : undefined;
  }
  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const query = await this.query(document, position);
    if (!query) { return undefined; }
    const candidates = query.candidates.filter((candidate) => candidate.name === query.name);
    if (!candidates.length && !query.routes?.length && !query.documentation) { return undefined; }
    const content = new vscode.MarkdownString();
    content.appendText(query.routes?.map((route) => `${route.methods} ${route.path}\n${route.name}\n${route.controller}`).join('\n\n') ??
      candidates.map((candidate) => `${candidate.label}\n${candidate.projectPath}`).join('\n\n'));
    const explanation = query.documentation ?? candidates.find((candidate) => candidate.documentation)?.documentation;
    if (explanation) { content.appendMarkdown(`${content.value ? '\n\n' : ''}${outletDocumentation(explanation).value}`); }
    if (query.routes?.length) {
      const session = this.sessions.sessionFor(document)!;
      for (const route of query.routes) {
        const action = routeAction(this.sessions, session, route)?.action;
        if (action?.fields.length) { content.appendText(`\n\nJSON fields: ${action.fields.map((field) => field.name).join(', ')}`); }
        if (action?.templates.length) { content.appendText(`\n\nRenders: ${action.templates.join(', ')}`); }
        const consumers = [...new Set(routeConsumers(this.sessions, session, route).map((use) => use.projectPath))];
        if (consumers.length) { content.appendText(`\n\nUsed in:\n${consumers.join('\n')}\n\nUse Find All References to open consumers.`); }
      }
    }
    return new vscode.Hover(content, rangeOf(document, query.range));
  }
  async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext): Promise<vscode.Location[] | undefined> {
    const session = this.sessions.sessionFor(document), version = document.version;
    if (!session) { return undefined; }
    const query = await this.query(document, position);
    if (!query || !query.routes?.length && !query.outlet) { return undefined; }
    const targets: Target[] = query.outlet ? this.outlets.references(session, query.outlet)
      : query.routes!.flatMap((route) => routeConsumers(this.sessions, session, route).map((use) => ({ ...use, label: '' })));
    if (context.includeDeclaration) { targets.push(...query.declarations ?? query.candidates.filter((candidate) => candidate.name === query.name)); }
    const locations = new Map<string, vscode.Location>();
    for (const target of targets) {
      try {
        const doc = await vscode.workspace.openTextDocument(session.fileSystem.toUri(joinProjectPath(session.project.root, target.projectPath)));
        if (!ownsFrontendPath(this.sessions, session, target.projectPath)) { continue; }
        const location = new vscode.Location(doc.uri, rangeOf(doc, target.range));
        locations.set(`${doc.uri.toString()}:${target.range.start}`, location);
      } catch { /* Ignore a consumer removed while reading. */ }
    }
    return this.sessions.sessionFor(document) === session && document.version === version ? [...locations.values()] : undefined;
  }

  private async query(document: vscode.TextDocument, position: vscode.Position): Promise<Query | undefined> {
    const session = this.sessions.sessionFor(document);
    const path = session?.relativePathOf(enginePathOf(document.uri));
    if (!session || !path) { return undefined; }
    const version = document.version, offset = document.offsetAt(position), source = document.getText();
    const twig = path.endsWith('.twig');
    const scan = scanFrontend(source, twig);
    const refs = scan.references.filter((ref) => offset >= ref.range.start && offset <= ref.range.end ||
      ref.selector && offset >= ref.selector.range.start && offset <= ref.selector.range.end);
    const ref = refs.at(-1);
    let query: Query | undefined;
    if (path.endsWith('.php')) {
      const routes = session.frontend.routes.filter((route) => {
        const found = routeAction(this.sessions, session, route);
        return found?.projectPath === path && offset >= found.action.range.start && offset <= found.action.range.end;
      });
      if (routes.length) { query = this.routeQuery(session, routes, routes[0]!.name, { start: offset, end: offset }); }
    } else if (ref?.kind === 'route') {
      const routes = session.frontend.routes.filter((route) => route.name === ref.name);
      query = this.routeQuery(session, session.frontend.routes, ref.name, ref.range);
      query.routes = routes;
    } else if (ref?.kind === 'url') {
      const route = frontendIndex(this.sessions, session).resolve(ref, session.frontend.routes);
      if (route) { query = this.routeQuery(session, [route], ref.name, ref.range, true); }
    } else if (ref && twig) {
      if (ref.kind === 'outlet') {
        query = await this.outlets.twig(session, ref, offset);
        if (query && !ref.controller && offset < query.range.start) {
          const name = query.outlet!.controller;
          query = await this.stimulusQuery(session, { kind: 'controller', name, range: { start: ref.range.start, end: ref.range.start + name.length } }, offset);
        }
      } else { query = await this.stimulusQuery(session, ref, offset); }
    } else {
      const value = fetchValueReferences(source, scan.scripts).find((entry) => offset >= entry.range.start && offset <= entry.range.end);
      if (value) {
        const routes = frontendIndex(this.sessions, session).routesForValue(path, value.name, session.frontend.routes, session.frontend.controllers);
        if (routes.length) { query = this.routeQuery(session, routes, source.slice(value.range.start, value.range.end), value.range, true); }
      }
      const access = responseAccessAt(source, offset, twig);
      if (access) {
        const index = frontendIndex(this.sessions, session);
        const routes = access.endpoint.kind === 'stimulus-value'
          ? index.routesForValue(path, access.endpoint.name, session.frontend.routes, session.frontend.controllers)
          : [index.resolve(access.endpoint, session.frontend.routes)].filter((route): route is SymfonyRoute => !!route);
        const actions = routes.map((route) => routeAction(this.sessions, session, route));
        const sets = actions.map((action) => {
          let fields: readonly ResponseField[] = action?.action.fields ?? [];
          for (const part of access.path) { fields = fields.find((field) => field.name === part)?.fields ?? []; }
          return fields;
        });
        const candidates = (sets[0] ?? []).filter((field) => /^[a-zA-Z_$][\w$]*$/.test(field.name) && sets.every((set) => set.some((entry) => entry.name === field.name)))
          .flatMap((field) => actions.flatMap((action, i): Candidate[] => action ? [{ name: field.name,
            projectPath: action.projectPath, range: sets[i]!.find((entry) => entry.name === field.name)!.range,
            label: `JSON response · ${routes[i]!.name}`, kind: vscode.CompletionItemKind.Field }] : []));
        query = { name: access.name, range: access.range, candidates };
      }
      if (!query && /\.[jt]s$/.test(path)) { query = await this.outlets.javascript(session, path, source, offset); }
    }
    return this.sessions.sessionFor(document) === session && document.version === version ? query : undefined;
  }

  private routeQuery(session: ProjectSession, routes: readonly SymfonyRoute[], name: string, range: OffsetRange, useLabel = false): Query {
    return { name, range, routes, targets: routes.filter((route) => useLabel || route.name === name).flatMap((route) => {
      const action = routeAction(this.sessions, session, route);
      return (action?.action.templates ?? []).flatMap((name): Target[] => {
        const template = session.lookup(name);
        return template && ownsFrontendPath(this.sessions, session, template.projectPath)
          ? [{ projectPath: template.projectPath, range: { start: 0, end: 0 }, label: `Renders ${name}` }] : [];
      });
    }), candidates: routes.flatMap((route): Candidate[] => {
      const action = routeAction(this.sessions, session, route);
      return action ? [{ name: useLabel ? name : route.name, projectPath: action.projectPath, range: action.action.range,
        label: `${route.methods} ${route.path}`, kind: vscode.CompletionItemKind.Reference }] : [];
    }) };
  }
  private async stimulusQuery(session: ProjectSession, ref: FrontendReference, offset: number): Promise<Query> {
    const controllers = session.frontend.controllers.filter((controller) => ownsFrontendPath(this.sessions, session, controller.projectPath));
    if (ref.kind === 'controller') {
      return { name: ref.name, range: ref.range, candidates: controllers.map((controller) => ({ ...controller,
        range: { start: 0, end: 0 }, label: `Stimulus controller · ${controller.projectPath}`, kind: vscode.CompletionItemKind.Class })) };
    }
    let controllerName = ref.controller, name = ref.name, range = ref.range, html = false;
    if (ref.kind === 'value' && controllerName === undefined) {
      controllerName = controllers.filter((controller) => name.startsWith(`${controller.name}-`)).sort((a, b) => b.name.length - a.name.length)[0]?.name;
      if (controllerName) {
        if (offset <= range.start + controllerName.length) {
          return this.stimulusQuery(session, { kind: 'controller', name: controllerName,
            range: { start: range.start, end: range.start + controllerName.length } }, offset);
        }
        name = name.slice(controllerName.length + 1); range = { start: range.start + controllerName.length + 1, end: range.end }; html = true;
      }
    }
    const controller = controllers.find((entry) => entry.name === controllerName);
    const candidates: Candidate[] = [];
    if (controller) {
      const uri = session.fileSystem.toUri(joinProjectPath(session.project.root, controller.projectPath));
      if ((await session.fileSystem.stat(enginePathOf(uri)))?.type === 'file') {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const info = stimulusSource(doc.getText());
          const members = ref.kind === 'action' ? info.actions : ref.kind === 'target' ? info.targets : info.values;
          candidates.push(...members.map((member) => ({ name: html ? stimulusHtmlName(member.name) : member.name,
            projectPath: controller.projectPath, range: member.range, label: `Stimulus ${ref.kind} · ${controller.name}`,
            kind: ref.kind === 'action' ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Property })));
        } catch { /* A registration whose source vanished cannot offer members. */ }
      }
    }
    return { name, range, candidates };
  }
}
function rangeOf(document: vscode.TextDocument, range: OffsetRange): vscode.Range { return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)); }
function outletDocumentation(text: string): vscode.MarkdownString {
  const content = new vscode.MarkdownString(); content.appendText(text);
  // appendText escapes source names safely, but turns spaces into nonbreaking
  // spaces. Let explanatory paragraphs wrap in a narrow hover or suggest panel.
  content.value = content.value.replaceAll('&nbsp;', ' ');
  content.appendMarkdown('\n\n[Stimulus outlet reference](https://stimulus.hotwired.dev/reference/outlets)');
  return content;
}
