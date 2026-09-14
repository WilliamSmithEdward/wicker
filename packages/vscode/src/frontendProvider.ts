import * as vscode from 'vscode';
import { ACTION_OPTIONS, COMMON_EVENTS, EVENT_TARGETS, KEY_FILTERS,
  cssImports, cssUrls, importSpecifiers, joinProjectPath, resolveRelativeImport, responseAccessAt,
  stimulusCallbackOwners, stimulusGeneratedMembers, stimulusHtmlName, stimulusSource,
  type FrontendReference, type OffsetRange, type ResponseField, type StimulusMember, type StimulusValue,
  type SymfonyRoute } from '@wicker/core';
import { enginePathOf } from './paths.js';
import type { ProjectSession, SessionManager } from './session.js';
import { fetchValuesOf, frontendIndex, ownsFrontendPath, routeAction, routeConsumers, scanOf } from './frontendProject.js';
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
    // An empty path marks a candidate that exists only to be completed: an
    // event name or an action option is Stimulus vocabulary, not a project
    // symbol, so there is nowhere to go.
    const matches = [...query.candidates.filter((candidate) => candidate.name === query.name && candidate.projectPath !== ''),
      ...query.targets ?? []];
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
    const scan = scanOf(session, path, source, twig);
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
    } else if (ref?.kind === 'actionParam') {
      query = this.actionParamQuery(session, ref);
    } else if (ref && ['event', 'keyFilter', 'eventTarget', 'actionOption'].includes(ref.kind)) {
      query = descriptorQuery(ref);
      if (ref.kind === 'event') { query.candidates.push(...this.dispatchedEvents(session)); }
    } else if (ref?.kind === 'asset' || ref?.kind === 'entrypoint') {
      query = this.assetQuery(session, ref);
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
      const value = fetchValuesOf(session, path, source, scan).find((entry) => offset >= entry.range.start && offset <= entry.range.end);
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
      if (!query && /\.[jt]s$/.test(path)) { query = this.importQuery(session, path, source, offset); }
      if (!query && /\.[jt]s$/.test(path)) { query = await this.outlets.javascript(session, path, source, offset); }
      if (!query && path.endsWith('.css')) { query = this.stylesheetQuery(session, path, source, offset); }
      if (!query && /\.[jt]s$/.test(path)) { query = this.callbackQuery(path, source, offset); }
      if (/\.[jt]s$/.test(path)) { query = this.withGeneratedMembers(session, path, source, offset, query); }
    }
    return this.sessions.sessionFor(document) === session && document.version === version ? query : undefined;
  }

  /**
   * An action parameter, which declares nothing anywhere.
   *
   * Stimulus collects `data-<controller>-<name>-param` onto `event.params`, so
   * the name is invented in the template and read in the handler with nothing
   * connecting the two. There is no declaration to navigate to and none to
   * complete from, so the only honest thing to offer is what it becomes.
   */
  private actionParamQuery(session: ProjectSession, ref: FrontendReference): Query | undefined {
    const controllers = session.frontend.controllers
      .filter((entry) => ownsFrontendPath(this.sessions, session, entry.projectPath));
    const controller = controllers.filter((entry) => ref.name.startsWith(`${entry.name}-`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!controller) { return undefined; }

    const parameter = ref.name.slice(controller.name.length + 1)
      .replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
    return { name: ref.name, range: ref.range, candidates: [],
      documentation: `A handler in ${controller.name} reads this as event.params.${parameter}. `
        + 'Action parameters are declared nowhere, so the name here and the name in the handler must simply agree.' };
  }

  /**
   * What a stylesheet points at, through `@import` or `url()`.
   *
   * AssetMapper rewrites both to hashed URLs when it serves the sheet, so a
   * path that resolves to nothing becomes a missing image or font with no
   * error anywhere. Both are resolved relative to the stylesheet.
   */
  private stylesheetQuery(session: ProjectSession, path: string, source: string, offset: number): Query | undefined {
    const found = [...cssImports(source), ...cssUrls(source)]
      .find((entry) => offset >= entry.range.start && offset <= entry.range.end);
    if (!found) { return undefined; }

    const target = resolveRelativeImport(path, found.specifier)
      // A bare specifier in a stylesheet is a logical asset path rather than a
      // relative one, which is how a bundled font or icon set is written.
      ?? session.assets.map.lookup(found.specifier)?.projectPath;
    if (target === undefined) { return { name: found.specifier, range: found.range, candidates: [] }; }

    return { name: found.specifier, range: found.range, candidates: [{
      name: found.specifier, projectPath: target.replace(/[?#].*$/, ''), range: { start: 0, end: 0 },
      label: `Stylesheet reference · ${target}`, kind: vscode.CompletionItemKind.File,
    }] };
  }

  /**
   * A callback method, and the declaration that makes Stimulus call it.
   *
   * Nothing in the project calls `urlValueChanged()`. Stimulus finds it by
   * name because `url` is a declared value, so the two are connected by a
   * spelling convention and by nothing else. Rename the declaration without
   * the callback and the method is simply never called again, silently.
   */
  private callbackQuery(path: string, source: string, offset: number): Query | undefined {
    const owner = stimulusCallbackOwners(stimulusSource(source)).find((entry) =>
      offset >= entry.callback.range.start && offset <= entry.callback.range.end);
    if (!owner) { return undefined; }

    const article = owner.reason === 'changed' ? 'changes' : owner.reason;
    return {
      name: owner.callback.name, range: owner.callback.range,
      candidates: [{
        name: owner.callback.name, projectPath: path, range: owner.declaration.range,
        label: `Stimulus ${owner.kind} callback · ${owner.declaration.name}`,
        kind: vscode.CompletionItemKind.Method,
        documentation: `Stimulus calls this when the ${owner.kind} "${owner.declaration.name}" ${article}. `
          + 'It is connected by name only: renaming the declaration without renaming this method stops it running.',
      }],
    };
  }

  /**
   * The properties Stimulus generates, offered where `this.` is being read.
   *
   * `statusUrlValue`, `hasBusyClass` and `outputTarget` are declared nowhere:
   * Stimulus creates them at runtime from `static values`, `classes` and
   * `targets`. To every other tool they are unknown properties, so a typo in
   * one is silent until the page runs.
   *
   * Added to an existing query rather than replacing it, because the outlet
   * query answers the same position with better explanations for its own
   * members and would otherwise be the only kind offered in a controller that
   * declares both.
   */
  private withGeneratedMembers(session: ProjectSession, path: string, source: string,
    offset: number, query: Query | undefined): Query | undefined {
    const owned = session.frontend.controllers.some((controller) => controller.projectPath === path &&
      ownsFrontendPath(this.sessions, session, controller.projectPath));
    if (!owned) { return query; }

    const info = stimulusSource(source);
    const access = info.accesses.find((entry) => entry.receiver === undefined &&
      offset >= entry.range.start && offset <= entry.range.end);
    if (!access) { return query; }

    const candidates: Candidate[] = stimulusGeneratedMembers(info).map((member) => ({
      name: member.name, projectPath: path, range: member.declaration.range,
      label: `Stimulus ${member.kind} · ${member.declaration.name}`,
      kind: vscode.CompletionItemKind.Property,
      // The declaration is in this same file, so the useful sentence is what
      // the property is rather than where it lives.
      documentation: [`Generated by Stimulus from the ${member.kind} "${member.declaration.name}".`,
        ...typeNote(member.declaration)].join('\n\n'),
    }));
    if (!candidates.length) { return query; }

    if (query === undefined) {
      return { name: access.name, range: access.range, candidates };
    }
    query.candidates.push(...candidates.filter((candidate) =>
      !query.candidates.some((existing) => existing.name === candidate.name)));
    return query;
  }

  /**
   * Events the project's own controllers emit.
   *
   * `this.dispatch('added')` in `cart_controller.js` emits `cart:added`, and a
   * listener binds that composed name in a data-action. Nothing in either file
   * mentions the other, so this is the only place the two meet.
   *
   * Read from the index, which already holds a parsed source per file, so a
   * keystroke costs a lookup rather than re-reading every controller.
   */
  private dispatchedEvents(session: ProjectSession): Candidate[] {
    const index = frontendIndex(this.sessions, session);
    // The registered identifier, not one derived from the path: a controller's
    // name depends on which configured directory it sits under, and its
    // project path does not carry that.
    return session.frontend.controllers
      .filter((controller) => ownsFrontendPath(this.sessions, session, controller.projectPath))
      .flatMap((controller) => {
        const file = index.get(controller.projectPath);
        if (!file?.stimulus) { return []; }
        // Only the calls whose event name is composable. A dispatch overriding
        // the prefix names an event this cannot work out.
        return file.stimulus.dispatches.filter((entry) => entry.defaultPrefix).map((entry) => ({
          name: `${controller.name}:${entry.name}`, projectPath: controller.projectPath, range: entry.range,
          label: `Dispatched by ${controller.name}`, kind: vscode.CompletionItemKind.Event,
        }));
      });
  }

  /**
   * Where an import specifier points.
   *
   * Nothing bundles these: the browser resolves them against the importmap the
   * page ships. A relative specifier resolves against the importing file, and
   * anything else has to be a key of `importmap.php`, which is also the only
   * way to alias a path and avoid climbing out through `../../..`.
   */
  private importQuery(session: ProjectSession, path: string, source: string, offset: number): Query | undefined {
    const found = importSpecifiers(source).find((entry) => offset >= entry.range.start && offset <= entry.range.end);
    if (!found) { return undefined; }

    const candidates: Candidate[] = session.assets.importMap
      .flatMap((entry) => entry.projectPath === undefined ? [] : [{
        name: entry.specifier, projectPath: entry.projectPath, range: { start: 0, end: 0 },
        label: `Importmap${entry.entrypoint ? ' entrypoint' : ''} · ${entry.projectPath}`,
        kind: vscode.CompletionItemKind.Module,
      }]);

    // A relative specifier names a file directly, so it is navigable without
    // appearing in the importmap at all.
    const relative = resolveRelativeImport(path, found.specifier);
    if (relative !== undefined) {
      candidates.push({ name: found.specifier, projectPath: relative, range: { start: 0, end: 0 },
        label: `Relative import · ${relative}`, kind: vscode.CompletionItemKind.File });
    }

    return { name: found.specifier, range: found.range, candidates };
  }

  /**
   * Logical asset names, or the entrypoints the importmap declares.
   *
   * Two different vocabularies. `asset()` takes a logical path, which is a
   * file's position within a configured root. `importmap()` takes a key of
   * `importmap.php` that was declared an entrypoint. Offering one where the
   * other belongs would suggest names that resolve to nothing.
   */
  private assetQuery(session: ProjectSession, ref: FrontendReference): Query {
    const { map, importMap } = session.assets;
    if (ref.kind === 'entrypoint') {
      return { name: ref.name, range: ref.range, candidates: importMap
        .filter((entry) => entry.entrypoint && entry.projectPath !== undefined)
        .map((entry) => ({ name: entry.specifier, projectPath: entry.projectPath!,
          range: { start: 0, end: 0 }, label: 'Importmap entrypoint',
          kind: vscode.CompletionItemKind.Module })) };
    }
    return { name: ref.name, range: ref.range, candidates: map.logicalPaths().flatMap((logicalPath) => {
      const asset = map.lookup(logicalPath);
      // Opening the file is the useful destination; a logical path names no
      // position inside it.
      return asset ? [{ name: logicalPath, projectPath: asset.projectPath, range: { start: 0, end: 0 },
        label: `Mapped asset · ${asset.projectPath}`, kind: vscode.CompletionItemKind.File }] : [];
    }) };
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
      const query: Query = { name: ref.name, range: ref.range, candidates: controllers.map((controller) => ({ ...controller,
        range: { start: 0, end: 0 }, label: `Stimulus controller · ${controller.projectPath}`, kind: vscode.CompletionItemKind.Class })) };
      // An unregistered name looks exactly like a registered one in the markup,
      // and Stimulus says nothing either way.
      const reason = controllers.some((entry) => entry.name === ref.name)
        ? undefined : unresolvedReason('controller', undefined, undefined, ref.name);
      return ref.name.length > 0 && reason ? { ...query, documentation: reason } : query;
    }
    let controllerName = ref.controller, name = ref.name, range = ref.range, html = false;
    if ((ref.kind === 'value' || ref.kind === 'class') && controllerName === undefined) {
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
          const members = ref.kind === 'action' ? info.actions : ref.kind === 'target' ? info.targets
            : ref.kind === 'class' ? info.classes : info.values;
          candidates.push(...members.map((member) => ({ name: html ? stimulusHtmlName(member.name) : member.name,
            projectPath: controller.projectPath, range: member.range, label: `Stimulus ${ref.kind} · ${controller.name}`,
            kind: ref.kind === 'action' ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Property,
            ...explain(ref, controller.name, controller.projectPath, member) })));
        } catch { /* A registration whose source vanished cannot offer members. */ }
      }
    }
    // A binding that resolves explains itself through the member it found.
    // One that does not would otherwise say nothing at all, which is the case
    // a reader most needs explained.
    const unresolved = name.length > 0 && !candidates.some((candidate) => candidate.name === name)
      ? unresolvedReason(ref.kind, controllerName, controller?.projectPath, name)
      : undefined;
    return { name, range, candidates, ...(unresolved ? { documentation: unresolved } : {}) };
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

/**
 * Completion for the half of an action descriptor that names no project symbol.
 *
 * These are Stimulus's own vocabularies and cannot be discovered from a
 * project, so they are listed. An empty project path marks them as
 * completion-only: there is nowhere for navigation to go.
 *
 * Events are offered but never warned about. Any DOM event is legal, and so is
 * any name a controller dispatches, so an unrecognised one is not a mistake.
 */
function descriptorQuery(ref: FrontendReference): Query {
  const [names, label] = ref.kind === 'event' ? [COMMON_EVENTS, 'DOM event']
    : ref.kind === 'keyFilter' ? [KEY_FILTERS, 'Stimulus key filter']
      : ref.kind === 'eventTarget' ? [EVENT_TARGETS, 'Global listener target']
        : [ACTION_OPTIONS, 'Stimulus action option'];
  return { name: ref.name, range: ref.range, candidates: names.map((name) => ({
    name, projectPath: '', range: { start: 0, end: 0 }, label,
    kind: vscode.CompletionItemKind.EnumMember })) };
}

/**
 * What a binding does, in this project's own names.
 *
 * A template says `click->cart#add` and a controller declares `add()`. Each
 * half is meaningless alone, and the reader is usually looking at the half
 * that does not contain the answer. These sentences name the other half and
 * the file it lives in, so the connection can be read without opening
 * anything.
 *
 * A value also carries its type and default, because the type decides what
 * `this.xValue` actually is and the default is what it holds when the template
 * binds nothing.
 */
function explain(ref: FrontendReference, controller: string, projectPath: string,
  member: StimulusMember): { documentation?: string } {
  const file = projectPath.slice(projectPath.lastIndexOf('/') + 1);
  const sentences: string[] = [];

  if (ref.kind === 'action') {
    sentences.push(ref.event === undefined
      ? `This element's default event calls ${member.name}() in ${file}.`
      : `A ${ref.event} on this element calls ${member.name}() in ${file}.`);
  } else if (ref.kind === 'target') {
    sentences.push(`${controller} reads this element as this.${member.name}Target in ${file}.`);
  } else if (ref.kind === 'value') {
    sentences.push(`Sets this.${member.name}Value, read by ${file}.`);
  } else if (ref.kind === 'class') {
    sentences.push(`${file} applies the classes written here through its ${member.name} class name.`);
  }

  sentences.push(...typeNote(member));
  return sentences.length ? { documentation: sentences.join('\n\n') } : {};
}

/**
 * A value's declared type and default, as a sentence or nothing.
 *
 * The type decides what `this.xValue` actually is, since Stimulus converts the
 * attribute with it, and the default is what the property holds when the
 * template binds nothing.
 */
function typeNote(member: StimulusMember): string[] {
  const { type, defaultText } = member as StimulusValue;
  if (type === undefined && defaultText === undefined) { return []; }
  const parts = [type === undefined ? 'Untyped' : `Type ${type}`];
  if (defaultText !== undefined) { parts.push(`default ${defaultText}`); }
  return [`${parts.join(', ')}.`];
}

/**
 * Why a binding connects to nothing.
 *
 * Stimulus reports none of this. An unknown controller, an unknown method and
 * an unknown target all fail the same way: nothing is attached, nothing is
 * logged, and the element simply does not respond. Saying which of the three
 * it is turns a silent page into a fixable one.
 */
function unresolvedReason(kind: FrontendReference['kind'], controller: string | undefined,
  projectPath: string | undefined, name: string): string | undefined {
  if (controller === undefined) {
    return kind === 'controller'
      ? `No controller named "${name}" is registered in this project, so Stimulus connects nothing to this element.`
      : undefined;
  }
  if (projectPath === undefined) {
    return `"${controller}" is registered but its source could not be read, so its members cannot be checked.`;
  }

  const file = projectPath.slice(projectPath.lastIndexOf('/') + 1);
  if (kind === 'action') {
    return `${file} declares no ${name}() method, so Stimulus attaches no listener and this element does nothing.`;
  }
  if (kind === 'target') {
    return `${file} does not declare "${name}" in static targets, so the controller cannot reach this element.`;
  }
  if (kind === 'value') {
    return `${file} does not declare "${name}" in static values, so this attribute is ignored.`;
  }
  if (kind === 'class') {
    return `${file} does not declare "${name}" in static classes, so these class names are never applied.`;
  }
  return undefined;
}
