import { resolveOutletReference, typescriptSourceForJavascript, type FrontendIndex } from '@wicker/core';
import type { ProjectSession, SessionManager } from './session.js';
import { frontendIndex, ownsFrontendPath, routeAction } from './frontendProject.js';

export interface RelatedScript {
  readonly projectPath: string;
  readonly reasons: readonly string[];
  readonly generatedPaths: readonly string[];
}

/** Explicit Stimulus bindings in a template and its literal includes/layouts. */
export function templateScripts(sessions: SessionManager, session: ProjectSession, names: readonly string[]): readonly RelatedScript[] {
  const index = frontendIndex(sessions, session);
  return mergeScripts(index, scriptsFromTemplates(sessions, session, index, names));
}

export function controllerScripts(sessions: SessionManager, session: ProjectSession,
  controller: { projectPath: string; className: string }): readonly RelatedScript[] {
  if (!ownsFrontendPath(sessions, session, controller.projectPath)) { return []; }
  const index = frontendIndex(sessions, session);
  const names = session.renderSites.index.controllers().find((entry) =>
    entry.projectPath === controller.projectPath && entry.className === controller.className)?.sites.map((site) => site.templateName) ?? [];
  const scripts = scriptsFromTemplates(sessions, session, index, names);
  for (const route of session.frontend.routes) {
    const target = routeAction(sessions, session, route);
    if (target?.projectPath !== controller.projectPath || target.action.className !== controller.className) { continue; }
    for (const use of index.consumers(route, session.frontend.routes, session.frontend.controllers)) {
      if (/\.[jt]s$/.test(use.projectPath)) { scripts.push({ projectPath: use.projectPath, reason: `Uses ${route.methods} ${route.path}` }); }
    }
  }
  return mergeScripts(index, scripts);
}

interface ScriptConnection { readonly projectPath: string; readonly reason: string }
function scriptsFromTemplates(sessions: SessionManager, session: ProjectSession, index: FrontendIndex, names: readonly string[]): ScriptConnection[] {
  const queue = [...new Set(names)], visited = new Set<string>();
  const result: ScriptConnection[] = [];
  for (let at = 0; at < queue.length; at++) {
    const name = queue[at]!;
    const template = session.lookup(name);
    if (!template || visited.has(template.projectPath)) { continue; }
    visited.add(template.projectPath);
    const file = index.get(template.projectPath);
    if (!file) { continue; }
    for (const ref of file.scan.references) {
      const outlet = resolveOutletReference(ref, session.frontend.controllers);
      const controllerName = ref.kind === 'controller' ? ref.name : outlet?.controller ?? ref.controller;
      const target = outlet && session.frontend.controllers.find((controller) => controller.name === outlet.name);
      if (target && ownsFrontendPath(sessions, session, target.projectPath)) {
        result.push({ projectPath: target.projectPath, reason: `Outlet ${outlet.controller} → ${outlet.name} in ${name}` });
      }
      const matches = session.frontend.controllers.filter((controller) => controller.name === controllerName ||
        !controllerName && ['value', 'class'].includes(ref.kind) && ref.name.startsWith(`${controller.name}-`));
      // A raw data-value or data-class prefix can match two identifiers. Keep only the longest.
      const controller = matches.sort((a, b) => b.name.length - a.name.length)[0];
      if (controller && ownsFrontendPath(sessions, session, controller.projectPath)) {
        result.push({ projectPath: controller.projectPath, reason: `Stimulus ${controller.name} in ${name}` });
      }
    }
    for (const ref of file.templateReferences) {
      if (['extends', 'include', 'include-function', 'embed'].includes(ref.kind) && !ref.isCandidateList) { queue.push(ref.templateName); }
    }
  }
  return result;
}

function mergeScripts(index: FrontendIndex, connections: readonly ScriptConnection[]): RelatedScript[] {
  const result = new Map<string, { projectPath: string; reasons: Set<string>; generatedPaths: Set<string> }>();
  for (const connection of connections) {
    const source = index.get(connection.projectPath)?.source;
    // Vendor Stimulus registrations are authoritative but excluded from the
    // editable source index; they can still be opened at their registered path.
    const preferred = source === undefined ? undefined : typescriptSourceForJavascript(connection.projectPath, source,
      (path) => index.get(path)?.source);
    const path = preferred ?? connection.projectPath;
    let entry = result.get(path);
    if (!entry) { entry = { projectPath: path, reasons: new Set(), generatedPaths: new Set() }; result.set(path, entry); }
    entry.reasons.add(connection.reason);
    if (preferred) { entry.generatedPaths.add(connection.projectPath); }
  }
  return [...result.values()].map((entry) => ({ projectPath: entry.projectPath, reasons: [...entry.reasons], generatedPaths: [...entry.generatedPaths] }))
    .sort((a, b) => a.projectPath.localeCompare(b.projectPath));
}
