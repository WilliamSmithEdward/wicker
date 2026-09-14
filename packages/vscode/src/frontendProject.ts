import { joinProjectPath, type FrontendIndex, type EndpointAction, type EndpointUse, type SymfonyRoute, type PhpTypeDeclaration, type PhpDependency } from '@wicker/core';
import type { ProjectSession, SessionManager } from './session.js';

export function ownsFrontendPath(sessions: SessionManager, session: ProjectSession, path: string): boolean {
  return sessions.sessionFor({ uri: session.fileSystem.toUri(joinProjectPath(session.project.root, path)) }) === session;
}

/** Queries are scoped as well as documents: parent projects must never borrow
 * registrations or consumer bindings from a nested workspace's sources. */
export function frontendIndex(sessions: SessionManager, session: ProjectSession): FrontendIndex {
  return session.frontendSources.index.filtered((path) => ownsFrontendPath(sessions, session, path));
}

export function routeAction(sessions: SessionManager, session: ProjectSession, route: SymfonyRoute):
  { projectPath: string; action: EndpointAction } | undefined {
  const [className, methodName = '__invoke'] = route.controller.split('::');
  const matches = session.frontendSources.index.all().flatMap((file) => ownsFrontendPath(sessions, session, file.projectPath)
    ? file.actions.filter((action) => action.className.toLowerCase() === className?.toLowerCase() &&
      action.methodName.toLowerCase() === methodName.toLowerCase()).map((action) => ({ projectPath: file.projectPath, action })) : []);
  return matches.length === 1 ? matches[0] : undefined;
}

export function routeConsumers(sessions: SessionManager, session: ProjectSession, route: SymfonyRoute): readonly EndpointUse[] {
  return frontendIndex(sessions, session).consumers(route, session.frontend.routes, session.frontend.controllers);
}

export function apiRoutes(sessions: SessionManager, session: ProjectSession): readonly SymfonyRoute[] {
  const index = frontendIndex(sessions, session);
  return session.frontend.routes.filter((route) => {
    if (route.format === 'json' || routeAction(sessions, session, route)?.action.json) { return true; }
    return index.all().some((file) => file.scan.requests.some((request) => index.resolve(request, session.frontend.routes)?.name === route.name)) ||
      index.consumers(route, session.frontend.routes, session.frontend.controllers).some((use) => use.via);
  }).sort(compareRoutePaths);
}

export function templateRoutes(sessions: SessionManager, session: ProjectSession): readonly SymfonyRoute[] {
  return session.frontend.routes.filter((route) => {
    const action = routeAction(sessions, session, route)?.action;
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
