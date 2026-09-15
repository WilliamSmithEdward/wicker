import { controllerForReference, fetchValueReferences, resolveRelativeImport, scanFrontend, type FrontendIndex, type FrontendScan, type EndpointAction, type EndpointUse, type OffsetRange, type StimulusController, type SymfonyRoute, type PhpTypeDeclaration, type PhpDependency } from '@wicker/core';
import { isEnabled, type ProjectSession, type SessionManager } from './session.js';

/**
 * What the tracker already parsed for exactly this text, or a fresh parse.
 *
 * Every tracked file is scanned as it is indexed, and a provider is nearly
 * always asked about a file in that state, so parsing it again per hover,
 * completion and definition was repeating work already done. A file the index
 * does not hold, or a document edited since it was indexed, still parses
 * directly: the source is compared, not assumed.
 */
export function scanOf(session: ProjectSession, path: string, source: string, twig: boolean): FrontendScan {
  const indexed = session.frontendSources.index.get(path);
  return indexed?.source === source ? indexed.scan : scanFrontend(source, twig);
}

/** The `fetch(this.xValue)` sites for this text, reusing the indexed parse. */
export function fetchValuesOf(session: ProjectSession, path: string, source: string,
  scan: FrontendScan): readonly { name: string; range: OffsetRange }[] {
  const indexed = session.frontendSources.index.get(path);
  return indexed?.source === source ? indexed.fetchValues : fetchValueReferences(source, scan.scripts);
}

export function isStylesheet(projectPath: string): boolean {
  return projectPath.toLowerCase().endsWith('.css');
}

/**
 * The file a specifier written in one file resolves to.
 *
 * A relative specifier names a file directly. A bare one is resolved by the
 * mechanism belonging to the file it was written in: `importmap.php` declares
 * the browser's bare module specifiers, while a stylesheet's bare reference is
 * a logical asset path, which is how a bundled font or icon set is written.
 *
 * Reaching for the other one invents a resolution the browser would not make.
 * Written out separately, the loading chain came to draw an edge for a bare
 * script import that the import diagnostics were reporting as unresolvable at
 * the same moment, and the stylesheet list could not follow a bare `@import`
 * at all.
 */
export function resolveSpecifier(session: ProjectSession, from: string, specifier: string): string | undefined {
  return resolveRelativeImport(from, specifier) ?? (isStylesheet(from)
    ? session.assets.map.lookup(specifier)?.projectPath
    : session.assets.importMap.find((entry) => entry.specifier === specifier)?.projectPath);
}

/**
 * The scoped copy of the index, kept until something can change it.
 *
 * Deciding ownership means building a URI and resolving the session for every
 * file, and callers ask for this several times to answer one hover, so
 * rebuilding it per call was pure repetition. The three things that can change
 * the answer are the files themselves, which workspace folders exist, and
 * whether the extension is switched on at all.
 */
const scoped = new WeakMap<ProjectSession, { version: number; layout: number; enabled: boolean; index: FrontendIndex }>();

/** Queries are scoped as well as documents: parent projects must never borrow
 * registrations or consumer bindings from a nested workspace's sources. */
export function frontendIndex(sessions: SessionManager, session: ProjectSession): FrontendIndex {
  const source = session.frontendSources.index;
  const enabled = isEnabled();
  const found = scoped.get(session);
  if (found !== undefined && found.version === source.version &&
    found.layout === sessions.layoutVersion && found.enabled === enabled) {
    return found.index;
  }
  const index = source.filtered((path) => sessions.owns(session, path));
  scoped.set(session, { version: source.version, layout: sessions.layoutVersion, enabled, index });
  return index;
}

/**
 * Which templates bind each Stimulus controller, built once per index.
 *
 * The reverse of the walk that lists a page's scripts, and the direction
 * neither file states: a controller is named in the markup, never the other
 * way round, so a controller file alone cannot say where it is mounted.
 *
 * Keyed by controller name rather than path, because that is the only name the
 * markup uses, and derived in one pass because asking per controller would
 * read every template once per controller.
 */
const bindings = new WeakMap<FrontendIndex, ReadonlyMap<string, readonly string[]>>();

export function templatesBinding(sessions: SessionManager, session: ProjectSession, name: string): readonly string[] {
  // Keyed on the scoped index itself: it is rebuilt whenever anything that
  // could change the answer changes, and holding it by identity means the
  // derived map is dropped with it rather than outliving what it describes.
  const index = frontendIndex(sessions, session);
  const found = bindings.get(index);
  if (found !== undefined) { return found.get(name) ?? []; }
  const byController = new Map<string, string[]>();
  for (const file of index.all()) {
    if (!file.projectPath.endsWith('.twig')) { continue; }
    for (const ref of file.scan.references) {
      const controller = controllerForReference(ref, session.frontend.controllers);
      if (controller === undefined) { continue; }
      const paths = byController.get(controller.name);
      if (paths === undefined) { byController.set(controller.name, [file.projectPath]); }
      else if (!paths.includes(file.projectPath)) { paths.push(file.projectPath); }
    }
  }
  for (const paths of byController.values()) { paths.sort((left, right) => left.localeCompare(right)); }
  bindings.set(index, byController);
  return byController.get(name) ?? [];
}

/** The controllers this session owns, in the order their names read. */
export function stimulusControllers(sessions: SessionManager, session: ProjectSession): readonly StimulusController[] {
  return session.frontend.controllers.filter((controller) => sessions.owns(session, controller.projectPath))
    .slice().sort((left, right) => left.name.localeCompare(right.name));
}

export function routeAction(sessions: SessionManager, session: ProjectSession, route: SymfonyRoute):
  { projectPath: string; action: EndpointAction } | undefined {
  return actionIn(frontendIndex(sessions, session), route);
}

/** The same answer for a caller that already holds the scoped index, so a loop
 * over routes resolves it once rather than once per route. */
function actionIn(index: FrontendIndex, route: SymfonyRoute):
  { projectPath: string; action: EndpointAction } | undefined {
  const [className, methodName = '__invoke'] = route.controller.split('::');
  if (className === undefined) { return undefined; }
  // Ambiguity stays unresolved: two classes of the same name cannot be told
  // apart from the route alone.
  const matches = index.actionsFor(className, methodName);
  return matches.length === 1 ? matches[0] : undefined;
}

export function routeConsumers(sessions: SessionManager, session: ProjectSession, route: SymfonyRoute): readonly EndpointUse[] {
  return frontendIndex(sessions, session).consumers(route, session.frontend.routes, session.frontend.controllers);
}

export function apiRoutes(sessions: SessionManager, session: ProjectSession): readonly SymfonyRoute[] {
  const index = frontendIndex(sessions, session);
  const { routes, controllers } = session.frontend;
  return routes.filter((route) => {
    if (route.format === 'json' || actionIn(index, route)?.action.json) { return true; }
    return index.isRequested(route, routes, controllers) ||
      index.consumers(route, routes, controllers).some((use) => use.via);
  }).sort(compareRoutePaths);
}

export function templateRoutes(sessions: SessionManager, session: ProjectSession): readonly SymfonyRoute[] {
  const index = frontendIndex(sessions, session);
  return session.frontend.routes.filter((route) => {
    const action = actionIn(index, route)?.action;
    return action && action.templates.length > 0 && !action.json && route.format !== 'json';
  }).sort(compareRoutePaths);
}

export function compareRoutePaths(left: SymfonyRoute, right: SymfonyRoute): number {
  return left.path.localeCompare(right.path);
}

export interface ControllerDependency {
  readonly projectPath: string;
  readonly declaration: PhpTypeDeclaration;
  readonly uses: readonly PhpDependency[];
}

/** Both ends must belong to this session. Interfaces link to the declaration,
 * not a guessed autowired implementation; duplicate declarations stay unresolved. */
export function controllerDependencies(sessions: SessionManager, session: ProjectSession,
  controller: { projectPath: string; className: string }): readonly ControllerDependency[] {
  const index = frontendIndex(sessions, session);
  const declarations = index.get(controller.projectPath)?.types.filter((type) => type.name === controller.className) ?? [];
  if (declarations.length !== 1) { return []; }
  const uses = declarations[0]!.dependencies.filter((dep) => dep.typeName.toLowerCase() !== controller.className.toLowerCase());
  const names = [...new Set(uses.map((use) => use.typeName.toLowerCase()))];
  return names.flatMap((key) => {
    // More than one declaration leaves the name ambiguous, and none means the
    // type is outside this project.
    const paths = index.classPaths(key);
    const declaration = paths.length === 1
      ? index.get(paths[0]!)?.types.find((type) => type.name.toLowerCase() === key) : undefined;
    return declaration === undefined ? [] : [{ projectPath: paths[0]!, declaration,
      uses: uses.filter((use) => use.typeName.toLowerCase() === key) }];
  })
    .sort((a, b) => a.declaration.name.split('\\').at(-1)!.localeCompare(b.declaration.name.split('\\').at(-1)!) ||
      a.declaration.name.localeCompare(b.declaration.name));
}
