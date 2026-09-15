import { controllerForReference, resolveOutletReference, typescriptSourceForJavascript, type FrontendIndex } from '@wicker/core';
import type { ProjectSession, SessionManager } from './session.js';
import { frontendIndex, routeAction } from './frontendProject.js';

export interface RelatedScript {
  readonly projectPath: string;
  readonly reasons: readonly string[];
  readonly generatedPaths: readonly string[];
}

/** Explicit Stimulus bindings in a template and its literal includes/layouts. */
export function templateScripts(sessions: SessionManager, session: ProjectSession, names: readonly string[]): Promise<readonly RelatedScript[]> {
  const index = frontendIndex(sessions, session);
  return mergeScripts(session, index, scriptsFromTemplates(sessions, session, index, names));
}

export function controllerScripts(sessions: SessionManager, session: ProjectSession,
  controller: { projectPath: string; className: string }): Promise<readonly RelatedScript[]> {
  if (!sessions.owns(session, controller.projectPath)) { return Promise.resolve([]); }
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
  return mergeScripts(session, index, scripts);
}

interface ScriptConnection { readonly projectPath: string; readonly reason: string }

/**
 * Visits a template and everything it literally pulls in.
 *
 * A page's real content is spread across its layout, its includes and its
 * embeds, so anything asked "what does this template use" has to follow the
 * same chain Twig does. Shared so that scripts and stylesheets cannot disagree
 * about which templates are involved.
 */
export function walkTemplates(session: ProjectSession, index: FrontendIndex, names: readonly string[],
  visit: (file: NonNullable<ReturnType<FrontendIndex['get']>>, name: string) => void): void {
  const queue = [...new Set(names)], visited = new Set<string>();
  for (let at = 0; at < queue.length; at++) {
    const name = queue[at]!;
    const template = session.lookup(name);
    if (!template || visited.has(template.projectPath)) { continue; }
    visited.add(template.projectPath);
    const file = index.get(template.projectPath);
    if (!file) { continue; }
    visit(file, name);
    for (const ref of file.templateReferences) {
      if (['extends', 'include', 'include-function', 'embed'].includes(ref.kind) && !ref.isCandidateList) { queue.push(ref.templateName); }
    }
  }
}

function scriptsFromTemplates(sessions: SessionManager, session: ProjectSession, index: FrontendIndex, names: readonly string[]): ScriptConnection[] {
  const result: ScriptConnection[] = [];
  walkTemplates(session, index, names, (file, name) => {
    for (const ref of file.scan.references) {
      const outlet = resolveOutletReference(ref, session.frontend.controllers);
      const target = outlet && session.frontend.controllers.find((controller) => controller.name === outlet.name);
      if (target && sessions.owns(session, target.projectPath)) {
        result.push({ projectPath: target.projectPath, reason: `Outlet ${outlet.controller} → ${outlet.name} in ${name}` });
      }
      const controller = controllerForReference(ref, session.frontend.controllers);
      if (controller && sessions.owns(session, controller.projectPath)) {
        result.push({ projectPath: controller.projectPath, reason: `Stimulus ${controller.name} in ${name}` });
      }
    }
  });
  return result;
}

async function mergeScripts(session: ProjectSession, index: FrontendIndex,
  connections: readonly ScriptConnection[]): Promise<RelatedScript[]> {
  const result = new Map<string, { projectPath: string; reasons: Set<string>; generatedPaths: Set<string> }>();
  for (const connection of connections) {
    const source = index.get(connection.projectPath)?.source;
    // Vendor Stimulus registrations are authoritative but excluded from the
    // editable source index; they can still be opened at their registered path.
    const preferred = source === undefined ? undefined : await typescriptSourceForJavascript(
      connection.projectPath, source, (path) => session.sourceOf(path));
    const path = preferred ?? connection.projectPath;
    let entry = result.get(path);
    if (!entry) { entry = { projectPath: path, reasons: new Set(), generatedPaths: new Set() }; result.set(path, entry); }
    entry.reasons.add(connection.reason);
    if (preferred) { entry.generatedPaths.add(connection.projectPath); }
  }
  return [...result.values()].map((entry) => ({ projectPath: entry.projectPath, reasons: [...entry.reasons], generatedPaths: [...entry.generatedPaths] }))
    .sort((a, b) => a.projectPath.localeCompare(b.projectPath));
}
