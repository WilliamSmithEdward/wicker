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
  type SymfonyProject,
} from '@wicker/core';

import { ProcessConsoleRunner } from './console.js';
import { VsCodeFileSystem } from './fileSystem.js';
import type { LoaderPathMemory } from './loaderPathMemory.js';
import { enginePathOf } from './paths.js';

const DEFAULT_EXTENSIONS = ['.twig'];

/**
 * One detected Symfony project, its template index, and the watchers that keep
 * the index honest while files change underneath it.
 */
export class ProjectSession implements vscode.Disposable {
  readonly project: SymfonyProject;
  readonly fileSystem: VsCodeFileSystem;
  /**
   * The workspace folder's own URI, kept so watchers and child URIs are built
   * from it rather than reconstructed from a path string. Rebuilding would
   * lose the scheme and authority of a remote workspace.
   */
  private readonly rootUri: vscode.Uri;

  private templateIndex: TwigTemplateIndex;
  /** Where the namespaces came from, so the UI can say so. */
  private loaderPathInfo: LoaderPathsResolution;
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshInFlight: Promise<void> | undefined;

  /** Fires after the index has been rebuilt. */
  readonly onDidChange = this.changed.event;

  private readonly memory: LoaderPathMemory;

  private constructor(
    project: SymfonyProject,
    rootUri: vscode.Uri,
    fileSystem: VsCodeFileSystem,
    index: TwigTemplateIndex,
    loaderPaths: LoaderPathsResolution,
    memory: LoaderPathMemory,
  ) {
    this.project = project;
    this.rootUri = rootUri;
    this.fileSystem = fileSystem;
    this.templateIndex = index;
    this.loaderPathInfo = loaderPaths;
    this.memory = memory;
    this.installWatchers();
  }

  /** Where the namespace list came from, and why, for status reporting. */
  get loaderPaths(): LoaderPathsResolution {
    return this.loaderPathInfo;
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
    return new ProjectSession(
      project,
      folder.uri,
      fileSystem,
      built.index,
      built.loaderPaths,
      memory,
    );
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
    return this.fileSystem.toUri(joinProjectPath(this.project.root, template.projectPath));
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
    return this.templateIndex.allNames().find((name) => name === 'base.html.twig');
  }

  /** Rebuilds the index now, collapsing concurrent callers onto one build. */
  async refresh(): Promise<void> {
    if (this.refreshInFlight !== undefined) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = (async () => {
      const built = await buildIndex(this.fileSystem, this.project, this.memory);
      this.templateIndex = built.index;
      this.loaderPathInfo = built.loaderPaths;
      this.changed.fire();
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
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 250);
  }

  private installWatchers(): void {
    const watch = (pattern: string, onAny: () => void): void => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.rootUri, pattern),
      );
      watcher.onDidCreate(onAny);
      watcher.onDidDelete(onAny);
      this.watchers.push(watcher);
    };

    // Template files: creation and deletion change what resolves. Edits do not,
    // so onDidChange is deliberately not wired here.
    watch('**/*.twig', () => this.scheduleRefresh());

    // Namespace configuration: an edit does change resolution, so this one
    // listens for content changes too.
    const configWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.rootUri, TWIG_CONFIG_PATH),
    );
    configWatcher.onDidCreate(() => this.scheduleRefresh());
    configWatcher.onDidDelete(() => this.scheduleRefresh());
    configWatcher.onDidChange(() => this.scheduleRefresh());
    this.watchers.push(configWatcher);
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.changed.dispose();
  }
}

async function buildIndex(
  fileSystem: VsCodeFileSystem,
  project: SymfonyProject,
  memory: LoaderPathMemory,
): Promise<{ index: TwigTemplateIndex; loaderPaths: LoaderPathsResolution }> {
  const raw = await fileSystem.readFile(joinProjectPath(project.root, TWIG_CONFIG_PATH));
  const config = parseTwigConfig(raw ?? '');

  // twig.yaml only declares the namespaces an application registers for
  // itself. Bundle namespaces such as @Twig exist nowhere in configuration, so
  // the console is asked first, an earlier console answer is the fallback, and
  // the configuration is the last resort.
  const loaderPaths = await resolveLoaderPaths(
    ProcessConsoleRunner.create(project.root),
    loaderPathsFromTwigConfig(config),
    memory.read(project.root),
  );

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
  return { index, loaderPaths };
}

/**
 * Owns one session per workspace folder and routes documents to the right one.
 */
export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, ProjectSession>();
  private readonly changed = new vscode.EventEmitter<void>();

  readonly onDidChange = this.changed.event;

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
    this.sessions.set(key, session);
    this.changed.fire();
  }

  removeFolder(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    this.sessions.get(key)?.dispose();
    if (this.sessions.delete(key)) {
      this.changed.fire();
    }
  }

  /** The session governing a document, if any. */
  sessionFor(document: vscode.TextDocument): ProjectSession | undefined {
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

  all(): readonly ProjectSession[] {
    return [...this.sessions.values()];
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.all().map((session) => session.refresh()));
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.changed.dispose();
  }
}
