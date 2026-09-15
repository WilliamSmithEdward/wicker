import { controllerForReference, resolveOutletReference, typescriptSourceForJavascript, type FrontendIndex, type StimulusController, type TwigTemplateIndex } from '@wicker/core';
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

/** One attribute wiring a controller to the markup around it. */
export interface BoundWiring {
  readonly kind: 'action' | 'target' | 'value' | 'class' | 'outlet' | 'actionParam';
  readonly name: string;
  /** The event half of an action descriptor, or the element's default where
   * the descriptor names none. */
  readonly event?: string;
  /** True when the event was implied by the element rather than written. */
  readonly impliedEvent?: boolean;
  /** The element an outlet points at. */
  readonly selector?: string;
  /** Where the attribute is written, which may be a layout rather than the
   * template the reader started from. */
  readonly projectPath: string;
  readonly offset: number;
}

/** A controller a page mounts, and the template the attribute is written in. */
export interface BoundController {
  readonly name: string;
  readonly projectPath: string;
  readonly boundIn: readonly string[];
  readonly wiring: readonly BoundWiring[];
}

const WIRING_KINDS: readonly BoundWiring['kind'][] = ['action', 'target', 'value', 'class', 'outlet', 'actionParam'];
function wiringKind(kind: string): BoundWiring['kind'] | undefined {
  return WIRING_KINDS.find((known) => known === kind);
}

/**
 * Held per index, because the tree asks the same question for every row.
 *
 * Deciding whether a template has a Stimulus group, labelling the group,
 * listing the controllers, and drawing each controller and each wiring row all
 * need the same walk. Expanding one page asked for it around twenty times.
 */
const mounted = new WeakMap<FrontendIndex, {
  controllers: readonly StimulusController[];
  templates: TwigTemplateIndex;
  byNames: Map<string, readonly BoundController[]>;
}>();

/**
 * The Stimulus controllers a page mounts, by identifier.
 *
 * The same walk the script list uses, because a binding written in a layout is
 * live on every page that extends it, and reading only the page's own markup
 * would miss the controllers that are on nearly every screen.
 *
 * By identifier rather than by file: the identifier is what the markup says,
 * what the browser matches, and what someone reading the page is looking at.
 */
export function templateControllers(sessions: SessionManager, session: ProjectSession,
  names: readonly string[]): readonly BoundController[] {
  const index = frontendIndex(sessions, session);
  let held = mounted.get(index);
  // The walk resolves names through the template index, so a template that
  // appears is a new answer even when no scanned file changed; and a
  // rediscovery can replace the controller list without touching a file.
  // Both are held by identity, because both are replaced wholesale.
  if (held === undefined || held.controllers !== session.frontend.controllers || held.templates !== session.index) {
    held = { controllers: session.frontend.controllers, templates: session.index, byNames: new Map() };
    mounted.set(index, held);
  }
  const key = names.join('\n');
  const found = held.byNames.get(key);
  if (found !== undefined) { return found; }
  const built = walkControllers(sessions, session, index, names);
  held.byNames.set(key, built);
  return built;
}

function walkControllers(sessions: SessionManager, session: ProjectSession,
  index: FrontendIndex, names: readonly string[]): readonly BoundController[] {
  const found = new Map<string, { name: string; projectPath: string; boundIn: string[]; wiring: BoundWiring[] }>();
  walkTemplates(session, index, names, (file, name) => {
    for (const ref of file.scan.references) {
      const controller = controllerForReference(ref, session.frontend.controllers);
      if (controller === undefined || !sessions.owns(session, controller.projectPath)) { continue; }
      const entry = found.get(controller.name) ??
        { name: controller.name, projectPath: controller.projectPath, boundIn: [], wiring: [] };
      if (!entry.boundIn.includes(name)) { entry.boundIn.push(name); }
      found.set(controller.name, entry);
      const kind = wiringKind(ref.kind);
      // A value or class attribute written without a controller carries the
      // identifier as its own prefix, which is not part of the declared name.
      const bare = ref.controller === undefined && ['value', 'class'].includes(ref.kind) &&
        ref.name.startsWith(`${controller.name}-`) ? ref.name.slice(controller.name.length + 1) : ref.name;
      if (kind === undefined) { continue; }
      // The same target or action can be on many elements; the list answers
      // what is wired, not how many times.
      // Every occurrence, not one row per distinct name. Two elements with the
      // same target are two places in the markup, and the row exists to reach
      // the one you meant.
      const event = ref.event ?? ref.defaultEvent;
      entry.wiring.push({ kind, name: bare, projectPath: file.projectPath, offset: ref.range.start,
        ...(event === undefined ? {} : { event }),
        ...(ref.event === undefined && ref.defaultEvent !== undefined ? { impliedEvent: true } : {}),
        ...(ref.selector === undefined ? {} : { selector: ref.selector.name }) });
    }
  });
  for (const entry of found.values()) {
    entry.wiring.sort((left, right) => WIRING_KINDS.indexOf(left.kind) - WIRING_KINDS.indexOf(right.kind) ||
      left.name.localeCompare(right.name) || (left.event ?? '').localeCompare(right.event ?? '') ||
      left.projectPath.localeCompare(right.projectPath) || left.offset - right.offset);
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
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
