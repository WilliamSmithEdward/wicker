import { joinProjectPath, type FrontendIndex, type EndpointAction, type EndpointUse, type SymfonyRoute, type PhpTypeDeclaration, type PhpDependency } from '@wicker/core';
import { isEnabled, type ProjectSession, type SessionManager } from './session.js';

export function ownsFrontendPath(sessions: SessionManager, session: ProjectSession, path: string): boolean {
  return sessions.sessionFor({ uri: session.fileSystem.toUri(joinProjectPath(session.project.root, path)) }) === session;
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
  const index = source.filtered((path) => ownsFrontendPath(sessions, session, path));
  scoped.set(session, { version: source.version, layout: sessions.layoutVersion, enabled, index });
  return index;
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
  const targets = new Map<string, { projectPath: string; declaration: PhpTypeDeclaration }[]>();
  const names = new Set(uses.map((use) => use.typeName.toLowerCase()));
  for (const file of index.all()) {
    for (const declaration of file.types) {
      const key = declaration.name.toLowerCase();
      if (names.has(key)) { targets.set(key, [...targets.get(key) ?? [], { projectPath: file.projectPath, declaration }]); }
    }
  }
  return [...targets.entries()].flatMap(([key, matches]) => matches.length === 1
    ? [{ ...matches[0]!, uses: uses.filter((use) => use.typeName.toLowerCase() === key) }] : [])
    .sort((a, b) => a.declaration.name.split('\\').at(-1)!.localeCompare(b.declaration.name.split('\\').at(-1)!) ||
      a.declaration.name.localeCompare(b.declaration.name));
}
