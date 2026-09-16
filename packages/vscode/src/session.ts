import * as vscode from 'vscode';

import {
  discoverSymfonyProject,
  extensionsFromPatterns,
  loaderPathsFromTwigConfig,
  parseTemplateName,
  parseTwigConfig,
  resolveLoaderPaths,
  TwigTemplateIndex,
  TWIG_CONFIG_PATH,
  joinProjectPath,
  normalizeRootPath,
  toProjectPath,
  type IndexedTemplate,
  type LoaderPathsResolution,
  type RenderSite,
  type SymfonyProject,
  type ConsoleResult,
  type ConsoleRunner,
  type TwigContextVariable,
} from '@wicker/core';

import { ProcessConsoleRunner } from './console.js';
import { discoverComponents, type ComponentDiscovery } from './componentDiscovery.js';
import { VsCodeFileSystem, type KnownSources } from './fileSystem.js';
import type { LoaderPathMemory } from './loaderPathMemory.js';
import { dirname, enginePathOf, inIgnoredDirectory } from './paths.js';
import { RenderSiteTracker } from './renderSiteTracker.js';
import { TemplateContextTracker } from './templateContextTracker.js';
import { FrontendTracker } from './frontendTracker.js';
import { discoverAssets, type AssetDiscovery } from './assetDiscovery.js';
import { discoverFrontend, type FrontendDiscovery } from './frontendDiscovery.js';

const DEFAULT_EXTENSIONS = ['.twig'];

/** The conventional Symfony layout, offered when scaffolding a new template. */
const LAYOUT_TEMPLATE = 'base.html.twig';

/** Trees that are generated or installed rather than written. */
const GENERATED_DIRECTORIES = ['var', 'node_modules', '.git'];

/**
 * How many times a refresh may rebuild before handing back to the debounce.
 *
 * One rebuild answers the ordinary case. A second covers a change that landed
 * while the first was running, which is what an awaited reindex after a
 * settings change depends on. Beyond that the project is moving faster than it
 * can be indexed, and looping only burns the editor's one thread.
 */
const MAX_REFRESH_PASSES = 3;

/**
 * Whether Wicker's editor features are switched on, read once per turn of the
 * event loop.
 *
 * Ownership is decided once per controller, render site, binding and script
 * connection, and each answer asked this, so building a configuration snapshot
 * was the largest single cost in drawing the tree.
 *
 * Held for the current turn only. A synchronous pass over a project reads it
 * once; anything that has awaited since, which includes every caller that
 * could observe a setting the user has just changed, reads it again.
 */
let enabled: boolean | undefined;

export function isEnabled(): boolean {
  if (enabled === undefined) {
    enabled = vscode.workspace.getConfiguration('wicker').get<boolean>('enable', true);
    queueMicrotask(() => { enabled = undefined; });
  }
  return enabled;
}

/**
 * One detected Symfony project, its template index, and the watchers that keep
 * the index honest while files change underneath it.
 */
export class ProjectSession implements vscode.Disposable {
  readonly project: SymfonyProject;
  readonly fileSystem: VsCodeFileSystem;
  readonly renderSites: RenderSiteTracker;
  readonly templateContexts: TemplateContextTracker;
  readonly frontendSources: FrontendTracker;
  frontend: FrontendDiscovery;
  /** Mapped assets and the importmap, for asset() and bare imports. */
  assets: AssetDiscovery;
  /**
   * The workspace folder's own URI, kept so watchers and child URIs are built
   * from it rather than reconstructed from a path string. Rebuilding would
   * lose the scheme and authority of a remote workspace.
   */
  private readonly rootUri: vscode.Uri;

  private templateIndex: TwigTemplateIndex;
  /** Where the namespaces came from, so the UI can say so. */
  private loaderPathInfo: LoaderPathsResolution;
  private componentInfo: ComponentDiscovery;
  private readonly watchers: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private refreshRevision = 0;
  /** The widest thing any change since the last pass could have invalidated. */
  private pendingScope: RefreshScope = 'templates';
  /** The revision the last pass to finish cleanly had answered for. */
  private completedRevision = 0;
  /** Configuration answers from the console, kept until configuration changes. */
  private readonly consoleAnswers = new Map<string, ConsoleResult>();
  private discoveryPending = false;
  /** Files read from disk on demand, cleared whenever the project is rebuilt. */
  private readonly sourceMaps = new Map<string, string | undefined>();
  private disposed = false;

  /** Fires after the index has been rebuilt. */
  readonly onDidChange = this.changed.event;

  private readonly memory: LoaderPathMemory;

  private constructor(
    project: SymfonyProject,
    rootUri: vscode.Uri,
    fileSystem: VsCodeFileSystem,
    index: TwigTemplateIndex,
    loaderPaths: LoaderPathsResolution,
    components: ComponentDiscovery,
    frontend: FrontendDiscovery,
    assets: AssetDiscovery,
    memory: LoaderPathMemory,
  ) {
    this.project = project;
    this.rootUri = rootUri;
    this.fileSystem = fileSystem;
    this.renderSites = new RenderSiteTracker(project.root, fileSystem);
    this.templateContexts = new TemplateContextTracker(project.root, fileSystem, (path) => this.relativePathOf(path));
    this.templateIndex = index;
    this.loaderPathInfo = loaderPaths;
    this.componentInfo = components;
    this.frontend = frontend;
    this.assets = assets;
    this.frontendSources = new FrontendTracker(project.root, fileSystem);
    this.memory = memory;
    this.installWatchers();
  }

  /** Where the namespace list came from, and why, for status reporting. */
  get loaderPaths(): LoaderPathsResolution {
    return this.loaderPathInfo;
  }

  get components(): ComponentDiscovery { return this.componentInfo; }

  /**
   * Applies every buffer edit the trackers are still holding.
   *
   * A keystroke schedules its re-parse rather than running it, and a query
   * arriving before typing pauses has to see the text as it is now. Every
   * query resolves its session first, so this is where the deferred work is
   * done, and only when there is any.
   */
  settle(): void {
    this.frontendSources.flush();
    this.renderSites.flush();
    this.templateContexts.flush();
  }

  /** The console command as configured, so a failure can name what was run. */
  get consoleCommand(): string | undefined {
    return ProcessConsoleRunner.create(this.project.root)?.describe();
  }

  /** Console data describes saved files; unsaved registration edits cannot disprove a name. */
  get canCheckCallables(): boolean {
    return !this.discoveryPending && !vscode.workspace.textDocuments.some((document) =>
      document.isDirty && this.affectsTwigEnvironment(document.uri));
  }

  /** Detects a project at or above a workspace folder, and indexes it. */
  static async create(
    folder: vscode.WorkspaceFolder,
    memory: LoaderPathMemory,
  ): Promise<ProjectSession | undefined> {
    const fileSystem = new VsCodeFileSystem(folder.uri);
    const project = await discoverSymfonyProject(fileSystem, enginePathOf(folder.uri));
    if (project === undefined) {
      return undefined;
    }
    const built = await buildIndex(fileSystem, project, memory);
    const session = new ProjectSession(
      project,
      folder.uri,
      fileSystem,
      built.index,
      built.loaderPaths,
      built.components,
      built.frontend,
      built.assets,
      memory,
    );
    try {
      await session.rebuildIndexes(built.index);
      return session;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }

  /**
   * Rebuilds the three file indexes, reading each file once.
   *
   * The frontend sources go first because they cover every file the other two
   * want and more, so both can take the text from there instead of reading it
   * again. Before this, a project's PHP was read once for its render sites and
   * once for the frontend index, and its templates once for their contexts and
   * once more for the same index.
   */
  async rebuildIndexes(templates: TwigTemplateIndex, force = false): Promise<void> {
    // A map read before this point described files as they were then.
    this.sourceMaps.clear();
    const found = await this.frontendSources.refresh();
    const known: KnownSources = (path) => this.frontendSources.index.get(path)?.source;
    // The same search under the same exclusions has just run; only the PHP
    // half of it is the render site tracker's.
    await this.renderSites.refresh(known, found.filter((uri) => uri.path.endsWith('.php')));
    await this.templateContexts.refresh(templates, force, known);
  }

  /**
   * A file's text, from the index when it is there and from disk when it is
   * not.
   *
   * Resolving a source map wants two files: the map itself, which is not
   * indexed, and the TypeScript it names, which is. Maps are the largest files
   * a project has and nothing is parsed out of them; they matter only when a
   * script row turns out to be compiled output, so reading every one of them
   * to open a project was paying the whole cost for a question usually never
   * asked.
   *
   * What comes off disk is kept, because the tree asks about the same map
   * repeatedly while it is drawn, and dropped whenever the project rebuilds.
   */
  async sourceOf(projectPath: string): Promise<string | undefined> {
    const indexed = this.frontendSources.index.get(projectPath)?.source;
    if (indexed !== undefined) { return indexed; }
    if (!this.sourceMaps.has(projectPath)) {
      this.sourceMaps.set(projectPath,
        await this.fileSystem.readFile(joinProjectPath(this.project.root, projectPath)));
    }
    return this.sourceMaps.get(projectPath);
  }

  get index(): TwigTemplateIndex {
    return this.templateIndex;
  }

  /** True when a path lies inside this project. */
  contains(absolutePath: string): boolean {
    const normalized = normalizeRootPath(absolutePath);
    return (
      normalized === this.project.root || toProjectPath(this.project.root, normalized) !== undefined
    );
  }

  /** The project-relative form of a path, or undefined when it is outside. */
  relativePathOf(absolutePath: string): string | undefined {
    return toProjectPath(this.project.root, absolutePath);
  }

  lookup(templateName: string): IndexedTemplate | undefined {
    return this.templateIndex.lookup(templateName);
  }

  /** The editor URI for an indexed template. */
  uriFor(template: IndexedTemplate): vscode.Uri {
    return this.uriOf(template.projectPath);
  }

  /** The editor's URI for a project-relative path, built from this project's
   * own root so a remote workspace keeps its scheme and authority. */
  uriOf(projectPath: string): vscode.Uri {
    return this.fileSystem.toUri(joinProjectPath(this.project.root, projectPath));
  }

  /**
   * Where a template of this name would live, if it existed.
   *
   * The first loader directory registered for the namespace, which is the one
   * Twig would find first, so creating the file there makes the name resolve.
   * Undefined when the namespace is unknown: guessing a location for an
   * unregistered namespace would create a file Twig could never load.
   */
  suggestedPathFor(
    templateName: string,
  ): { projectPath: string; uri: vscode.Uri } | undefined {
    const parsed = parseTemplateName(templateName);
    if (!parsed.ok) {
      return undefined;
    }
    const [candidate] = this.loaderPathInfo.paths.resolveCandidates(parsed.value);
    if (candidate === undefined) {
      return undefined;
    }
    return {
      projectPath: candidate,
      uri: this.fileSystem.toUri(joinProjectPath(this.project.root, candidate)),
    };
  }

  /** The template most likely to be a layout, used when scaffolding a new file. */
  layoutTemplateName(): string | undefined {
    return this.templateIndex.lookup(LAYOUT_TEMPLATE) ? LAYOUT_TEMPLATE : undefined;
  }

  /** Coalesce requests, but repeat when a change arrived during an older build. */
  async refresh(scope: RefreshScope = 'environment'): Promise<void> {
    this.refreshRevision++;
    this.widenRefresh(scope);
    this.discoveryPending = true;
    this.changed.fire();
    if (this.refreshInFlight !== undefined) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = (async () => {
      /*
       * A finished build is always published, even when something changed
       * while it ran. It used to be discarded and rebuilt from nothing, so on
       * a project where a build takes seconds the next change almost always
       * arrived first and the index stayed empty for as long as anyone kept
       * working.
       *
       * Rebuilding immediately is still right for the ordinary case: a caller
       * that changed a setting and awaits an index reflecting it. The passes
       * are bounded so a project changing continuously cannot hold the loop,
       * and past the bound the debounce decides when things have settled.
       */
      for (let pass = 0; pass < MAX_REFRESH_PASSES; pass++) {
        const revision = this.refreshRevision;
        // Taken at the start of the pass: a change arriving while this pass
        // runs widens the next one rather than being lost.
        const scope = this.pendingScope;
        this.pendingScope = 'templates';
        if (scope === 'environment') { this.consoleAnswers.clear(); }
        const environment: Environment = scope === 'templates'
          ? { loaderPaths: this.loaderPathInfo, components: this.componentInfo, frontend: this.frontend, assets: this.assets }
          : await discoverEnvironment(this.fileSystem, this.project, this.memory, this.rememberingRunner());
        if (this.disposed) { return; }
        const index = await indexTemplates(this.fileSystem, this.project, environment.loaderPaths);
        if (this.disposed) { return; }
        this.templateIndex = index;
        this.loaderPathInfo = environment.loaderPaths;
        this.componentInfo = environment.components;
        this.frontend = environment.frontend;
        this.assets = environment.assets;
        await this.templateContexts.refresh(index);
        if (this.disposed) { return; }
        if (revision === this.refreshRevision) {
          this.completedRevision = revision;
          this.discoveryPending = false;
          this.changed.fire();
          return;
        }
        this.changed.fire();
      }
      this.scheduleRefresh();
    })().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  /**
   * Rebuilds shortly after the last of a burst of changes.
   *
   * A branch switch or a composer install touches many files at once; without
   * this the index would be rebuilt once per file.
   */
  private scheduleRefresh(scope: RefreshScope = 'environment'): void {
    this.refreshRevision++;
    this.widenRefresh(scope);
    if (!this.discoveryPending) {
      this.discoveryPending = true;
      this.changed.fire();
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      // A pass that started after this was scheduled has already answered
      // for it; running another would only repeat the answer.
      if (this.completedRevision < this.refreshRevision) {
        void this.refresh(this.pendingScope);
      }
    }, 350);
  }

  /** Two changes waiting together are answered by the wider of the two. */
  private widenRefresh(scope: RefreshScope): void {
    if (SCOPE_WIDTH[scope] > SCOPE_WIDTH[this.pendingScope]) { this.pendingScope = scope; }
  }

  /** The console, answering configuration questions from the last time it was asked. */
  private rememberingRunner(): ConsoleRunner | undefined {
    const inner = ProcessConsoleRunner.create(this.project.root);
    return inner === undefined ? undefined : new RememberingRunner(inner, this.consoleAnswers);
  }

  /**
   * How much a changed file can have invalidated, or nothing when it is not
   * one the environment is read from.
   *
   * PHP can register an extension, a route or a component and a script can be
   * a Stimulus controller, so those ask the console again for what PHP can
   * change. Configuration, dependencies and the environment files can move
   * anything, including where the console's own answers come from.
   */
  private scopeOfChange(uri: vscode.Uri): RefreshScope | undefined {
    if (!this.affectsTwigEnvironment(uri)) { return undefined; }
    const path = this.relativePathOf(enginePathOf(uri));
    return path !== undefined && path.endsWith('.php') ? 'php' : 'environment';
  }

  private affectsTwigEnvironment(uri: vscode.Uri): boolean {
    if (uri.scheme !== this.rootUri.scheme || uri.authority !== this.rootUri.authority) { return false; }
    const path = this.relativePathOf(enginePathOf(uri));
    return path !== undefined && !inIgnoredDirectory(path) &&
      (path.endsWith('.php') || /^config\/.*\.(?:ya?ml|xml)$/.test(path) ||
        ['composer.json', 'composer.lock', 'symfony.lock', '.env', '.env.local', '.env.dev', '.env.dev.local'].includes(path));
  }

  /**
   * The project-relative path of a watched file, unless its churn means
   * nothing.
   *
   * `var` is the loud one: Symfony rewrites its cache while the application
   * runs. `node_modules` and `.git` move in bulk during an install or a branch
   * switch. `vendor` is deliberately not here, because bundle templates and
   * packaged Stimulus controllers live there and are indexed.
   */
  /**
   * Whether a template file is one the component registry would list.
   *
   * An anonymous component is registered by nothing but its template, found
   * in the components directory of a loader path. The directory is settable,
   * so the ones the console has already reported components in are believed
   * alongside the default.
   */
  private isComponentTemplate(projectPath: string): boolean {
    const directories = new Set(['components']);
    for (const component of this.componentInfo.components) {
      const folder = dirname(component.template.replace(/^@!?[^/]+\//, ''));
      if (folder !== '') { directories.add(folder); }
    }
    for (const entry of this.loaderPathInfo.paths.all()) {
      for (const directory of entry.directories) {
        if (!projectPath.startsWith(`${directory}/`)) { continue; }
        const folder = dirname(projectPath.slice(directory.length + 1));
        if ([...directories].some((known) => folder === known || folder.startsWith(`${known}/`))) { return true; }
      }
    }
    return false;
  }

  private watchedPath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== this.rootUri.scheme || uri.authority !== this.rootUri.authority) { return undefined; }
    const path = this.relativePathOf(enginePathOf(uri));
    return path !== undefined && !path.split('/').some((part) => GENERATED_DIRECTORIES.includes(part))
      ? path : undefined;
  }

  private installWatchers(): void {
    const watch = (pattern: string, onAny: (uri: vscode.Uri) => void): void => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.rootUri, pattern),
      );
      watcher.onDidCreate(onAny);
      watcher.onDidDelete(onAny);
      this.watchers.push(watcher);
    };

    // Template files: creation and deletion change what resolves. Edits do not,
    // so onDidChange is deliberately not wired here. The URI is examined rather
    // than discarded, so a generated tree cannot queue a rebuild per file.
    const refreshForFile = (scopeOf: (path: string) => RefreshScope) => (uri: vscode.Uri): void => {
      const path = this.watchedPath(uri);
      if (path !== undefined) { this.scheduleRefresh(scopeOf(path)); }
    };
    // A new template changes nothing the console reports, with one exception:
    // an anonymous Twig component is a template, and debug:twig-component
    // lists it. A new script can be a Stimulus controller, which discovery
    // finds by walking the configured directories, so that one always asks.
    watch('**/*.twig', refreshForFile((path) => this.isComponentTemplate(path) ? 'environment' : 'templates'));
    watch('**/*.{js,ts}', refreshForFile(() => 'php'));
    // Maps are not indexed, but one that changes still has to invalidate what
    // was read from it. Watching is not reading: nothing here opens a file, it
    // only forgets one, so a deleted map stops pointing a row at a TypeScript
    // source that no longer describes it.
    const mapWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.rootUri, '**/*.map'));
    const forgetMap = (uri: vscode.Uri): void => {
      const path = this.relativePathOf(enginePathOf(uri));
      if (path !== undefined && this.sourceMaps.delete(path)) { this.changed.fire(); }
    };
    this.watchers.push(mapWatcher, mapWatcher.onDidCreate(forgetMap),
      mapWatcher.onDidChange(forgetMap), mapWatcher.onDidDelete(forgetMap));

    const stimulusWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.rootUri, '**/controllers.json'));
    this.watchers.push(stimulusWatcher, stimulusWatcher.onDidCreate(() => this.scheduleRefresh()),
      stimulusWatcher.onDidChange(() => this.scheduleRefresh()), stimulusWatcher.onDidDelete(() => this.scheduleRefresh()));

    // Twig extensions can live in any application PHP directory. Configuration
    // and dependency changes can register or remove them as well.
    const configWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.rootUri, '**/{*.php,*.yaml,*.yml,*.xml,composer.json,composer.lock,symfony.lock,.env,.env.*}'),
    );
    const refreshEnvironment = (uri: vscode.Uri): void => {
      const scope = this.scopeOfChange(uri);
      if (scope !== undefined) { this.scheduleRefresh(scope); }
    };
    configWatcher.onDidCreate(refreshEnvironment);
    configWatcher.onDidDelete(refreshEnvironment);
    configWatcher.onDidChange(refreshEnvironment);
    this.watchers.push(configWatcher);
    const dirty = new Set(vscode.workspace.textDocuments.filter((document) =>
      document.isDirty && this.affectsTwigEnvironment(document.uri)).map((document) => document.uri.toString()));
    const dirtyStateChanged = (document: vscode.TextDocument): void => {
      if (!this.affectsTwigEnvironment(document.uri)) { return; }
      const key = document.uri.toString();
      const wasDirty = dirty.has(key);
      if (document.isDirty && !document.isClosed) { dirty.add(key); }
      else { dirty.delete(key); }
      // Suspend warnings once on the first edit, not by rescanning every open
      // template on each PHP keystroke.
      if (wasDirty !== dirty.has(key)) { this.changed.fire(); }
    };
    this.watchers.push(
      vscode.workspace.onDidOpenTextDocument(dirtyStateChanged),
      vscode.workspace.onDidChangeTextDocument((event) => dirtyStateChanged(event.document)),
      vscode.workspace.onDidSaveTextDocument((document) => refreshEnvironment(document.uri)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        dirty.delete(document.uri.toString());
        refreshEnvironment(document.uri);
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.renderSites.dispose();
    this.templateContexts.dispose();
    this.frontendSources.dispose();
    this.changed.dispose();
  }
}

/** Everything the Symfony console has to be asked for. */
interface Environment {
  readonly loaderPaths: LoaderPathsResolution;
  readonly components: ComponentDiscovery;
  readonly frontend: FrontendDiscovery;
  readonly assets: AssetDiscovery;
}

/**
 * What a change can invalidate, narrowest first.
 *
 * A template created or deleted changes which names resolve and nothing the
 * console knows. A PHP or script change can add a route, a component, a Twig
 * extension or a Stimulus controller, so those three are asked again, but it
 * cannot move where the framework keeps its assets, where Stimulus looks for
 * controllers or where the project directory is: those come from
 * configuration, and their answers are kept until configuration changes.
 * Asking everything on every save cost six kernel boots per keystroke-and-save
 * in a controller, which on a container is most of a minute of waiting for
 * answers that could not have changed.
 */
type RefreshScope = 'templates' | 'php' | 'environment';
const SCOPE_WIDTH: Record<RefreshScope, number> = { templates: 0, php: 1, environment: 2 };

/**
 * Console commands whose answers only configuration can change.
 *
 * Held by the session across PHP-scoped refreshes and dropped on an
 * environment one. Matched on the exact argument list, so a command asked in
 * any other form is asked afresh.
 */
const CONFIGURATION_COMMANDS: readonly string[] = [
  JSON.stringify(['debug:config', 'stimulus', '--format=json', '--no-ansi', '--no-interaction']),
  JSON.stringify(['debug:config', 'framework', 'asset_mapper', '--format=json', '--no-ansi', '--no-interaction']),
  JSON.stringify(['debug:container', '--parameter=kernel.project_dir', '--format=json', '--no-ansi', '--no-interaction']),
];

/** A runner that answers the configuration commands from what it was told. */
class RememberingRunner implements ConsoleRunner {
  constructor(private readonly inner: ConsoleRunner, private readonly answers: Map<string, ConsoleResult>) {}

  async run(args: readonly string[]): Promise<ConsoleResult> {
    const key = JSON.stringify(args);
    const remembered = CONFIGURATION_COMMANDS.includes(key) ? this.answers.get(key) : undefined;
    if (remembered !== undefined) { return remembered; }
    const result = await this.inner.run(args);
    // Only a good answer is kept: a container that was down is asked again.
    if (result.ok && CONFIGURATION_COMMANDS.includes(key)) { this.answers.set(key, result); }
    return result;
  }
}

async function buildIndex(
  fileSystem: VsCodeFileSystem,
  project: SymfonyProject,
  memory: LoaderPathMemory,
): Promise<Environment & { index: TwigTemplateIndex }> {
  const environment = await discoverEnvironment(fileSystem, project, memory, ProcessConsoleRunner.create(project.root));
  return { ...environment, index: await indexTemplates(fileSystem, project, environment.loaderPaths) };
}

async function discoverEnvironment(
  fileSystem: VsCodeFileSystem,
  project: SymfonyProject,
  memory: LoaderPathMemory,
  runner: ConsoleRunner | undefined,
): Promise<Environment> {
  const raw = await fileSystem.readFile(joinProjectPath(project.root, TWIG_CONFIG_PATH));
  const config = parseTwigConfig(raw ?? '');

  // twig.yaml only declares the namespaces an application registers for
  // itself. Bundle namespaces such as @Twig exist nowhere in configuration, so
  // the console is asked first, an earlier console answer is the fallback, and
  // the configuration is the last resort.
  const [loaderPaths, components, frontend, assets] = await Promise.all([resolveLoaderPaths(
    runner,
    loaderPathsFromTwigConfig(config),
    memory.read(project.root),
  ), discoverComponents(fileSystem, project.root, runner), discoverFrontend(fileSystem, project.root, runner),
  discoverAssets(fileSystem, project.root, runner)]);

  // Only a fresh console answer is recorded, so a run with the container down
  // cannot overwrite a good answer with a worse one.
  if (loaderPaths.consoleEntries !== undefined) {
    await memory.write(project.root, loaderPaths.consoleEntries);
  }
  return { loaderPaths, components, frontend, assets };
}

/** The template names that resolve, given where the namespaces point. */
async function indexTemplates(
  fileSystem: VsCodeFileSystem,
  project: SymfonyProject,
  loaderPaths: LoaderPathsResolution,
): Promise<TwigTemplateIndex> {
  const raw = await fileSystem.readFile(joinProjectPath(project.root, TWIG_CONFIG_PATH));
  const config = parseTwigConfig(raw ?? '');
  const settings = vscode.workspace.getConfiguration('wicker');
  const configured = settings.get<string[]>('templates.extensions', []);
  const extensions =
    configured.length > 0
      ? configured
      : extensionsFromPatterns(config.fileNamePatterns, DEFAULT_EXTENSIONS);

  return TwigTemplateIndex.build(fileSystem, project.root, loaderPaths.paths, {
    extensions,
    maxFiles: settings.get<number>('index.maxFiles', 20000),
  });
}

/**
 * Owns one session per workspace folder and routes documents to the right one.
 */
export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, ProjectSession>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly renderSitesChanged = new vscode.EventEmitter<void>();
  private layout = 0;

  /**
   * What the set of open projects is on.
   *
   * Which session owns a file depends on which projects exist, so anything
   * caching an ownership decision has to notice a folder appearing or going
   * away. Nested projects make this real rather than theoretical.
   */
  get layoutVersion(): number { return this.layout; }

  readonly onDidChange = this.changed.event;
  readonly onDidChangeRenderSites = this.renderSitesChanged.event;

  constructor(private readonly memory: LoaderPathMemory) {}

  async initialize(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await this.addFolder(folder);
    }
  }

  async addFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    if (this.sessions.has(key)) {
      return;
    }
    const session = await ProjectSession.create(folder, this.memory);
    if (session === undefined) {
      return;
    }
    session.onDidChange(() => this.changed.fire());
    session.renderSites.onDidChange(() => this.renderSitesChanged.fire());
    session.frontendSources.onDidChange(() => this.renderSitesChanged.fire());
    this.sessions.set(key, session);
    this.layout++;
    this.changed.fire();
  }

  removeFolder(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    this.sessions.get(key)?.dispose();
    if (this.sessions.delete(key)) {
      this.layout++;
      this.changed.fire();
    }
  }

  /**
   * The session governing a document, if any.
   *
   * Every feature resolves its project through here, so returning nothing
   * while `wicker.enable` is off silences all of them at once: navigation,
   * hover, completion, colouring, quick fixes and diagnostics. That switch
   * exists for the case where another extension covers the same ground, and
   * an escape hatch is worth nothing unless it closes every exit.
   *
   * Indexing and the file watchers keep running, so turning it back on is
   * immediate rather than a rebuild.
   */
  sessionFor(document: Pick<vscode.TextDocument, 'uri'>): ProjectSession | undefined {
    if (!isEnabled()) {
      return undefined;
    }
    const path = enginePathOf(document.uri);
    let best: ProjectSession | undefined;
    for (const session of this.sessions.values()) {
      if (!session.contains(path)) {
        continue;
      }
      // Deepest root wins, so a nested project beats the repository around it.
      if (best === undefined || session.project.root.length > best.project.root.length) {
        best = session;
      }
    }
    // Whoever asked is about to read the session, and typing may still be
    // waiting to be applied.
    best?.settle();
    return best;
  }

  /**
   * Whether a project-relative path belongs to this session.
   *
   * Decided in one place, because a parent project borrowing a nested
   * project's controllers or templates produces answers that look like data
   * rather than like a bug.
   */
  /**
   * The session whose project root is exactly this URI, or nothing.
   *
   * A sidebar row carries the root of the project it was drawn for. Resolving
   * that root through `sessionFor` would also answer a parent project's
   * session for a nested project's root once the nested project is gone, and
   * a row from a project that no longer exists must open nothing.
   */
  sessionAtRoot(root: vscode.Uri): ProjectSession | undefined {
    const session = this.sessionFor({ uri: root });
    // The root is absolute already; uriOf would join it onto itself.
    return session !== undefined && session.fileSystem.toUri(session.project.root).toString() === root.toString()
      ? session : undefined;
  }

  /**
   * The same answer as `sessionFor`, without going through a URI.
   *
   * The caller already holds a path, and building a URI from it only for
   * `sessionFor` to turn it back into a path was most of the cost of a
   * question asked once per controller, render site and binding.
   */
  owns(session: ProjectSession, projectPath: string): boolean {
    if (!isEnabled()) { return false; }
    const path = joinProjectPath(session.project.root, projectPath);
    let best: ProjectSession | undefined;
    for (const other of this.sessions.values()) {
      // Deepest root wins, so a nested project beats the repository around it.
      if (other.contains(path) && (best === undefined || other.project.root.length > best.project.root.length)) {
        best = other;
      }
    }
    return best === session;
  }

  /** Direct render sites owned by the same project as this template. */
  /** How many templates extend the one in this document. */
  extendingTemplateCount(document: Pick<vscode.TextDocument, 'uri'>): number {
    const session = this.sessionFor(document);
    const path = session?.relativePathOf(enginePathOf(document.uri));
    if (session === undefined || path === undefined) { return 0; }
    const names = session.index.templatesForProjectPath(path).map((entry) => entry.name);
    const extending = new Set(names.flatMap((name) =>
      session.frontendSources.index.extendedBy(name).filter((source) => this.owns(session, source))));
    return extending.size;
  }

  renderSitesFor(document: Pick<vscode.TextDocument, 'uri'>): readonly RenderSite[] {
    const session = this.sessionFor(document);
    const path = session?.relativePathOf(enginePathOf(document.uri));
    if (session === undefined || path === undefined) {
      return [];
    }
    // A parent workspace can contain another open Symfony project. Its PHP
    // references belong to that deeper session, not to the parent's templates.
    return session.renderSites.index.forTemplate(path, session.index)
      .filter((site) => this.owns(session, site.projectPath));
  }

  all(): readonly ProjectSession[] {
    return [...this.sessions.values()];
  }

  contextVariablesFor(document: vscode.TextDocument, offset: number): readonly TwigContextVariable[] {
    const session = this.sessionFor(document);
    const path = session?.relativePathOf(enginePathOf(document.uri));
    if (session === undefined || path === undefined) { return []; }
    session.templateContexts.update(document);
    return session.templateContexts.index.variablesFor(path, offset, session.index, session.renderSites.index,
      (source) => this.owns(session, source));
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.all().map(async (session) => {
      await session.refresh();
      await session.rebuildIndexes(session.index, true);
    }));
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.changed.dispose();
    this.renderSitesChanged.dispose();
  }
}
