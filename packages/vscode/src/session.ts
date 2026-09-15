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
  type TwigContextVariable,
} from '@wicker/core';

import { ProcessConsoleRunner } from './console.js';
import { discoverComponents, type ComponentDiscovery } from './componentDiscovery.js';
import { VsCodeFileSystem, type KnownSources } from './fileSystem.js';
import type { LoaderPathMemory } from './loaderPathMemory.js';
import { enginePathOf, inIgnoredDirectory } from './paths.js';
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
    await this.frontendSources.refresh();
    const known: KnownSources = (path) => this.frontendSources.index.get(path)?.source;
    await this.renderSites.refresh(known);
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
  async refresh(): Promise<void> {
    this.refreshRevision++;
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
        const built = await buildIndex(this.fileSystem, this.project, this.memory);
        if (this.disposed) { return; }
        this.templateIndex = built.index;
        this.loaderPathInfo = built.loaderPaths;
        this.componentInfo = built.components;
        this.frontend = built.frontend;
        this.assets = built.assets;
        await this.templateContexts.refresh(built.index);
        if (this.disposed) { return; }
        if (revision === this.refreshRevision) {
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
  private scheduleRefresh(): void {
    this.refreshRevision++;
    if (!this.discoveryPending) {
      this.discoveryPending = true;
      this.changed.fire();
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 350);
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
    const refreshForFile = (uri: vscode.Uri): void => {
      if (this.watchedPath(uri) !== undefined) { this.scheduleRefresh(); }
    };
    watch('**/*.twig', refreshForFile);
    watch('**/*.{js,ts}', refreshForFile);
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
      if (this.affectsTwigEnvironment(uri)) { this.scheduleRefresh(); }
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

async function buildIndex(
  fileSystem: VsCodeFileSystem,
  project: SymfonyProject,
  memory: LoaderPathMemory,
): Promise<{ index: TwigTemplateIndex; loaderPaths: LoaderPathsResolution; components: ComponentDiscovery; frontend: FrontendDiscovery; assets: AssetDiscovery }> {
  const raw = await fileSystem.readFile(joinProjectPath(project.root, TWIG_CONFIG_PATH));
  const config = parseTwigConfig(raw ?? '');

  // twig.yaml only declares the namespaces an application registers for
  // itself. Bundle namespaces such as @Twig exist nowhere in configuration, so
  // the console is asked first, an earlier console answer is the fallback, and
  // the configuration is the last resort.
  const runner = ProcessConsoleRunner.create(project.root);
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

  const settings = vscode.workspace.getConfiguration('wicker');
  const configured = settings.get<string[]>('templates.extensions', []);
  const extensions =
    configured.length > 0
      ? configured
      : extensionsFromPatterns(config.fileNamePatterns, DEFAULT_EXTENSIONS);

  const index = await TwigTemplateIndex.build(fileSystem, project.root, loaderPaths.paths, {
    extensions,
    maxFiles: settings.get<number>('index.maxFiles', 20000),
  });
  return { index, loaderPaths, components, frontend, assets };
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
    return session.renderSites.index.forTemplate(path, session.index).filter((site) => {
      const uri = session.fileSystem.toUri(joinProjectPath(session.project.root, site.projectPath));
      // A parent workspace can contain another open Symfony project. Its PHP
      // references belong to that deeper session, not to the parent's templates.
      return this.sessionFor({ uri }) === session;
    });
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
