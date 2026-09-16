import type { OffsetRange } from '../php/templateReferences.js';
import { phpTypeDeclarations, type PhpTypeDeclaration } from '../php/dependencies.js';
import { scanTwigTemplateReferences, type TwigTemplateReference } from '../twig/twigReferences.js';
import { lexTwigRegions } from '../twig/twigLexer.js';
import { javascriptTokens } from './javascript.js';
import { scanFrontend, stimulusHtmlName, type FrontendReference, type FrontendScan } from './references.js';
import { endpointActions, literalUrlPath, type EndpointAction, type SymfonyRoute } from './routes.js';
import { stimulusSource, type StimulusController, type StimulusSource } from './stimulus.js';

export interface FrontendFile {
  readonly projectPath: string;
  readonly source: string;
  readonly scan: FrontendScan;
  readonly actions: readonly EndpointAction[];
  readonly types: readonly PhpTypeDeclaration[];
  readonly templateReferences: readonly TwigTemplateReference[];
  /** `fetch(this.xValue)` sites, parsed once here rather than per query. */
  readonly fetchValues: readonly { name: string; range: OffsetRange }[];
  readonly stimulus?: StimulusSource;
}
export interface EndpointUse { readonly projectPath: string; readonly range: OffsetRange; readonly via?: string }

/** A file that names a template, and the tag it named it with. */
export interface IncomingReference {
  readonly projectPath: string;
  readonly kind: TwigTemplateReference['kind'];
}
type IncomingMap = ReadonlyMap<string, readonly IncomingReference[]>;

/** Route lookups that depend only on the route list. */
interface RouteLookups {
  readonly routes: readonly SymfonyRoute[];
  readonly byName: ReadonlyMap<string, SymfonyRoute>;
  /** Literal paths only. A path several routes claim maps to null, which is
   * the ambiguity `routeForUrl` refuses to resolve. */
  readonly byPath: ReadonlyMap<string, SymfonyRoute | null>;
}

/** Everything derived from the files crossed with the routes and controllers. */
interface GraphLookups {
  readonly routes: readonly SymfonyRoute[];
  readonly controllers: readonly StimulusController[];
  readonly revision: number;
  readonly controllerNames: ReadonlyMap<string, readonly string[]>;
  /** Controller name, then value name, to the routes bound there. A binding
   * written without a controller is filed under the empty name. */
  readonly boundRoutes: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  readonly consumers: ReadonlyMap<string, readonly EndpointUse[]>;
  /** Routes some file actually asks for, as opposed to merely links to. */
  readonly requested: ReadonlySet<string>;
  /** Who asks for each route: a fetch written out, or a Stimulus value a
   * controller fetches. The reason a route that renders HTML is still an
   * endpoint, and the reason a row can say so. */
  readonly requesters: ReadonlyMap<string, readonly EndpointUse[]>;
}

export class FrontendIndex {
  private readonly files = new Map<string, FrontendFile>();
  private sourceSize = 0;
  /** Bumped whenever the file set changes, so a memo can tell it is stale. */
  private revision = 0;
  /** What the file set is on now. A caller holding a derived copy compares
   * this to know whether the copy still describes the index. */
  get version(): number { return this.revision; }
  private routeMemo?: RouteLookups;
  private graphMemo?: GraphLookups;
  private actionMemo?: { revision: number; byMethod: ReadonlyMap<string, readonly FileAction[]> };
  private incomingMemo?: { revision: number; byExtends: IncomingMap; byInclude: IncomingMap };
  private typeMemo?: { revision: number; byName: ReadonlyMap<string, readonly string[]> };

  update(projectPath: string, source: string): void {
    const held = this.files.get(projectPath)?.source.length ?? 0;
    // Bound what the index retains. The parsed structures come to several
    // times the text they came from, so the text is what is worth measuring,
    // and a project this large is past the point where holding all of it in
    // the editor's process is the right thing to do.
    if (this.sourceSize - held + source.length > MAX_RETAINED_BYTES) {
      this.remove(projectPath);
      return;
    }
    const scan = /\.(?:twig|js|ts)$/.test(projectPath)
      ? scanFrontend(source, projectPath.endsWith('.twig'))
      : { references: [], requests: [], bindings: [], scripts: [], routeCalls: [] };
    this.files.set(projectPath, { projectPath, source, scan,
      actions: projectPath.endsWith('.php') ? endpointActions(source) : [],
      types: projectPath.endsWith('.php') ? phpTypeDeclarations(source) : [],
      templateReferences: projectPath.endsWith('.twig') ? activeTemplateReferences(source) : [],
      fetchValues: fetchValueReferences(source, scan.scripts),
      ...(/\.[jt]s$/.test(projectPath) ? { stimulus: stimulusSource(source) } : {}) });
    this.sourceSize += source.length - held;
    this.revision++;
  }
  remove(projectPath: string): void {
    const found = this.files.get(projectPath);
    if (found === undefined) { return; }
    this.sourceSize -= found.source.length;
    this.files.delete(projectPath);
    this.revision++;
  }
  sourcePaths(): string[] { return [...this.files.keys()]; }
  all(): readonly FrontendFile[] { return [...this.files.values()]; }
  get(projectPath: string): FrontendFile | undefined { return this.files.get(projectPath); }
  filtered(owns: (path: string) => boolean): FrontendIndex {
    const result = new FrontendIndex();
    for (const [path, file] of this.files) {
      if (!owns(path)) { continue; }
      result.files.set(path, file);
      result.sourceSize += file.source.length;
    }
    // The copy is built by filling the map directly, so nothing has bumped its
    // revision and it would otherwise report version 0 for the life of the
    // project. A caller keying a cache on the version would then never see the
    // index change underneath it.
    result.revision = this.revision;
    return result;
  }

  /**
   * Controller actions by class and method.
   *
   * A route names its controller as `Class::method`, and every caller used to
   * find it by scanning every file's actions. There are as many such lookups
   * as there are routes, so the scan is done once and answered from a map.
   */
  actionsFor(className: string, methodName: string): readonly FileAction[] {
    if (this.actionMemo?.revision !== this.revision) {
      const byMethod = new Map<string, FileAction[]>();
      for (const file of this.files.values()) {
        for (const action of file.actions) {
          const key = `${action.className.toLowerCase()}::${action.methodName.toLowerCase()}`;
          const found = byMethod.get(key);
          if (found) { found.push({ projectPath: file.projectPath, action }); }
          else { byMethod.set(key, [{ projectPath: file.projectPath, action }]); }
        }
      }
      this.actionMemo = { revision: this.revision, byMethod };
    }
    return this.actionMemo.byMethod.get(`${className.toLowerCase()}::${methodName.toLowerCase()}`) ?? [];
  }

  /**
   * The templates that extend one, by the name they extend it under.
   *
   * The direction that is not in the file. A template says what it extends on
   * its first line, and that name already navigates; what a layout cannot say
   * is which pages are built on it, which is exactly what someone about to
   * change a block needs to know.
   *
   * Only `extends`, because that is what carries blocks. An include composes a
   * page without inheriting anything from it.
   */
  extendedBy(templateName: string): readonly string[] {
    return this.incoming().byExtends.get(templateName)?.map((entry) => entry.projectPath) ?? [];
  }

  /**
   * The templates that pull one in without inheriting from it.
   *
   * The same unstated direction as `extendedBy`, for the files that are never
   * extended: a partial, or a file of macros. Each carries the verb it was
   * referenced with, because "includes this" and "imports macros from this"
   * are answers to different questions and the reader can tell them apart
   * only by being told which one they are looking at.
   */
  includedBy(templateName: string): readonly IncomingReference[] {
    return this.incoming().byInclude.get(templateName) ?? [];
  }

  /**
   * The files declaring a class, by its fully qualified name.
   *
   * Several callers hold a class name from somewhere outside PHP - a route's
   * controller, a component registration - and need the file it lives in.
   * Asking by scanning every file's declarations costs one full pass each
   * time, and the answer does not depend on which name was asked about.
   *
   * More than one path means the name is ambiguous, which callers refuse to
   * resolve rather than picking one.
   */
  classPaths(className: string): readonly string[] {
    if (this.typeMemo?.revision !== this.revision) {
      const byName = new Map<string, string[]>();
      for (const file of this.files.values()) {
        for (const declaration of file.types) {
          const key = declaration.name.toLowerCase();
          const found = byName.get(key);
          if (found) { if (!found.includes(file.projectPath)) { found.push(file.projectPath); } }
          else { byName.set(key, [file.projectPath]); }
        }
      }
      this.typeMemo = { revision: this.revision, byName };
    }
    return this.typeMemo.byName.get(className.toLowerCase()) ?? [];
  }

  /** Both directions in one walk, since either question reads every file. */
  private incoming(): { byExtends: IncomingMap; byInclude: IncomingMap } {
    if (this.incomingMemo?.revision !== this.revision) {
      const byExtends = new Map<string, IncomingReference[]>();
      const byInclude = new Map<string, IncomingReference[]>();
      for (const file of this.files.values()) {
        for (const reference of file.templateReferences) {
          if (reference.isCandidateList) { continue; }
          const into = reference.kind === 'extends' ? byExtends : byInclude;
          const found = into.get(reference.templateName);
          if (found === undefined) {
            into.set(reference.templateName, [{ projectPath: file.projectPath, kind: reference.kind }]);
          } else if (!found.some((entry) => entry.projectPath === file.projectPath && entry.kind === reference.kind)) {
            found.push({ projectPath: file.projectPath, kind: reference.kind });
          }
        }
      }
      for (const map of [byExtends, byInclude]) {
        for (const entries of map.values()) {
          entries.sort((left, right) => left.projectPath.localeCompare(right.projectPath) ||
            left.kind.localeCompare(right.kind));
        }
      }
      this.incomingMemo = { revision: this.revision, byExtends, byInclude };
    }
    return this.incomingMemo;
  }

  /**
   * Every file that reaches a route, keyed by route name.
   *
   * Built in one pass over the index and reused for every route, because the
   * per-file work does not depend on which route is being asked about. Asking
   * per route meant walking the whole index once per route, and the Stimulus
   * half walked it again inside that, which put the cost at routes times files
   * squared.
   */
  consumers(route: SymfonyRoute, routes: readonly SymfonyRoute[], controllers: readonly StimulusController[]): readonly EndpointUse[] {
    return this.graph(routes, controllers).consumers.get(route.name) ?? [];
  }

  /** Whether any indexed file issues a request for this route, rather than
   * linking to it. Answered from the same single pass as the consumers. */
  isRequested(route: SymfonyRoute, routes: readonly SymfonyRoute[], controllers: readonly StimulusController[]): boolean {
    return this.graph(routes, controllers).requested.has(route.name);
  }

  /** The files that ask for this route: a fetch written out, or a Stimulus
   * value a controller fetches (`via` says which). */
  requesters(route: SymfonyRoute, routes: readonly SymfonyRoute[], controllers: readonly StimulusController[]): readonly EndpointUse[] {
    return this.graph(routes, controllers).requesters.get(route.name) ?? [];
  }
  resolve(ref: FrontendReference, routes: readonly SymfonyRoute[]): SymfonyRoute | undefined {
    return resolveWith(this.routeLookups(routes), ref);
  }
  routesForValue(projectPath: string, property: string, routes: readonly SymfonyRoute[], controllers: readonly StimulusController[]): readonly SymfonyRoute[] {
    const graph = this.graph(routes, controllers);
    const byName = this.routeLookups(routes).byName;
    const result = new Map<string, SymfonyRoute>();
    for (const name of graph.controllerNames.get(projectPath) ?? []) {
      const bound = [
        graph.boundRoutes.get(name)?.get(property),
        graph.boundRoutes.get('')?.get(`${name}-${stimulusHtmlName(property)}`),
      ];
      for (const routeName of bound.flatMap((names) => [...names ?? []])) {
        const found = byName.get(routeName);
        if (found) { result.set(found.name, found); }
      }
    }
    return [...result.values()];
  }

  private routeLookups(routes: readonly SymfonyRoute[]): RouteLookups {
    if (this.routeMemo?.routes === routes) { return this.routeMemo; }
    const byName = new Map<string, SymfonyRoute>();
    const byPath = new Map<string, SymfonyRoute | null>();
    for (const route of routes) {
      // First wins, matching the find() this replaces.
      if (!byName.has(route.name)) { byName.set(route.name, route); }
      if (/[{}]/.test(route.path)) { continue; }
      byPath.set(route.path, byPath.has(route.path) ? null : route);
    }
    this.routeMemo = { routes, byName, byPath };
    return this.routeMemo;
  }

  private graph(routes: readonly SymfonyRoute[], controllers: readonly StimulusController[]): GraphLookups {
    const memo = this.graphMemo;
    if (memo?.routes === routes && memo.controllers === controllers && memo.revision === this.revision) {
      return memo;
    }
    const lookups = this.routeLookups(routes);

    const controllerNames = new Map<string, string[]>();
    for (const controller of controllers) {
      const found = controllerNames.get(controller.projectPath);
      if (found) { found.push(controller.name); }
      else { controllerNames.set(controller.projectPath, [controller.name]); }
    }

    // A binding written on an element carries its controller; one written
    // without it is keyed by value alone, under an empty controller.
    const boundRoutes = new Map<string, Map<string, Set<string>>>();
    for (const file of this.files.values()) {
      for (const binding of file.scan.bindings) {
        const route = resolveWith(lookups, binding.endpoint);
        if (!route) { continue; }
        let byValue = boundRoutes.get(binding.controller);
        if (!byValue) { byValue = new Map(); boundRoutes.set(binding.controller, byValue); }
        const found = byValue.get(binding.value);
        if (found) { found.add(route.name); }
        else { byValue.set(binding.value, new Set([route.name])); }
      }
    }

    // Published before the consumer pass fills it, because that pass calls
    // routesForValue, which asks for this same graph. Everything it reads,
    // controllerNames and boundRoutes, is complete by now; only the consumer
    // map is still being written, and nothing in the pass reads it.
    const requested = new Set<string>();
    const requesters = new Map<string, EndpointUse[]>();
    const push = (into: Map<string, EndpointUse[]>, name: string, use: EndpointUse): void => {
      const found = into.get(name);
      if (found) { found.push(use); }
      else { into.set(name, [use]); }
    };
    for (const file of this.files.values()) {
      for (const request of file.scan.requests) {
        const route = resolveWith(lookups, request);
        if (route) {
          requested.add(route.name);
          push(requesters, route.name, { projectPath: file.projectPath, range: request.range });
        }
      }
    }

    const graph: GraphLookups = { routes, controllers, revision: this.revision, controllerNames, boundRoutes,
      consumers: new Map(), requested, requesters };
    this.graphMemo = graph;

    const consumers = graph.consumers as Map<string, EndpointUse[]>;
    for (const file of this.files.values()) {
      for (const ref of file.scan.references) {
        const route = resolveWith(lookups, ref);
        if (route) { push(consumers, route.name, { projectPath: file.projectPath, range: ref.range }); }
      }
      for (const value of file.fetchValues) {
        for (const route of this.routesForValue(file.projectPath, value.name, routes, controllers)) {
          const use: EndpointUse = { projectPath: file.projectPath, range: value.range, via: 'Stimulus value' };
          push(consumers, route.name, use);
          push(requesters, route.name, use);
        }
      }
    }
    return graph;
  }
}

/**
 * Source text the index will hold, in total.
 *
 * Matches the bound the template context index keeps, so the two cannot
 * disagree about how much of a project belongs in memory.
 */
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;

export interface FileAction { readonly projectPath: string; readonly action: EndpointAction }

function resolveWith(lookups: RouteLookups, ref: FrontendReference): SymfonyRoute | undefined {
  if (ref.kind === 'route') { return lookups.byName.get(ref.name); }
  if (ref.kind !== 'url') { return undefined; }
  const path = literalUrlPath(ref.name);
  return path === undefined ? undefined : lookups.byPath.get(path) ?? undefined;
}

function activeTemplateReferences(source: string): readonly TwigTemplateReference[] {
  const ignored: OffsetRange[] = [];
  let verbatim = false;
  for (const region of lexTwigRegions(source)) {
    if (verbatim) { ignored.push(region); }
    if (region.kind !== 'statement') { continue; }
    const tag = source.slice(region.innerStart, region.innerEnd).trim();
    if (/^verbatim\b/.test(tag)) { verbatim = true; }
    else if (/^endverbatim\b/.test(tag)) { verbatim = false; }
  }
  return scanTwigTemplateReferences(source).filter((ref) => !ignored.some((range) => ref.range.start >= range.start && ref.range.end <= range.end));
}

export function fetchValueReferences(source: string, scripts: readonly OffsetRange[]): readonly { name: string; range: OffsetRange }[] {
  return scripts.flatMap((script) => {
    const tokens = javascriptTokens(source, script.start, script.end);
    return tokens.flatMap((token, i) => token.text === 'fetch' && tokens[i + 1]?.text === '(' &&
      (!['.', '?.'].includes(tokens[i - 1]?.text ?? '') || ['window', 'globalThis'].includes(tokens[i - 2]?.text ?? '')) &&
      tokens[i + 2]?.text === 'this' && tokens[i + 3]?.text === '.' && tokens[i + 4]?.text.endsWith('Value') &&
      [')', ','].includes(tokens[i + 5]?.text ?? '')
      ? [{ name: tokens[i + 4]!.text.slice(0, -5), range: tokens[i + 4]! }] : []);
  });
}
