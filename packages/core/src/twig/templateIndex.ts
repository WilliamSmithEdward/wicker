/**
 * An index of every Twig template reachable through the project's loader paths.
 *
 * This exists for two reasons. Completion needs to enumerate what a user could
 * type, which a per-lookup filesystem probe cannot do. And resolution needs to
 * honour override order, where the same name is provided by more than one
 * directory and the first one wins.
 *
 * Both directions are kept. Name to file answers "where does this reference
 * go", and file to name answers "what is this template called", which is what
 * lets an open template say which controllers render it.
 */

import { type WickerFileSystem } from '../fs/fileSystem.js';
import { joinProjectPath } from '../util/paths.js';

import { type TwigLoaderPaths } from './loaderPaths.js';
import { formatTemplateName, type TwigTemplateName } from './templateName.js';

export interface IndexedTemplate {
  /** Canonical reference, e.g. `home/index.html.twig` or `@Maker/foo.twig`. */
  readonly name: string;
  /** Project-relative path to the file on disk. */
  readonly projectPath: string;
  readonly namespace: string | null;
  /** Path below the namespace root, which is the name minus its namespace. */
  readonly pathWithinNamespace: string;
  /** The loader directory this copy was found in. */
  readonly loaderDirectory: string;
  readonly forcesBundleTemplate: boolean;
  /** Position of the loader directory within its namespace; 0 resolves first. */
  readonly directoryPrecedence: number;
  /**
   * True when a directory earlier in the namespace also provides this name, so
   * Twig would never load this copy. Surfacing it lets the editor explain that
   * a bundle template is being overridden rather than silently ignored.
   */
  readonly shadowed: boolean;
}

export interface TemplateIndexOptions {
  /**
   * Filename suffixes to index. Twig does not require an extension, but
   * indexing everything under a loader path would pull in unrelated files, so
   * the convention is indexed and anything else is found by probe instead.
   */
  readonly extensions?: readonly string[];
  /** Upper bound on indexed files, so a misconfigured loader path cannot hang. */
  readonly maxFiles?: number;
  /** Directory names never descended into. */
  readonly skipDirectories?: readonly string[];
}

const DEFAULT_EXTENSIONS: readonly string[] = ['.twig'];
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_SKIP_DIRECTORIES: readonly string[] = ['.git', 'node_modules'];

export class TwigTemplateIndex {
  private readonly byName: ReadonlyMap<string, readonly IndexedTemplate[]>;
  private readonly byProjectPath: ReadonlyMap<string, readonly IndexedTemplate[]>;
  /** True when the walk stopped early, so callers know the index is partial. */
  readonly truncated: boolean;

  private constructor(
    byName: ReadonlyMap<string, readonly IndexedTemplate[]>,
    byProjectPath: ReadonlyMap<string, readonly IndexedTemplate[]>,
    truncated: boolean,
  ) {
    this.byName = byName;
    this.byProjectPath = byProjectPath;
    this.truncated = truncated;
  }

  static async build(
    fileSystem: WickerFileSystem,
    projectRoot: string,
    loaderPaths: TwigLoaderPaths,
    options: TemplateIndexOptions = {},
  ): Promise<TwigTemplateIndex> {
    const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const skipDirectories = new Set(options.skipDirectories ?? DEFAULT_SKIP_DIRECTORIES);

    const collected: IndexedTemplate[] = [];
    let truncated = false;

    for (const entry of loaderPaths.all()) {
      for (const [precedence, directory] of entry.directories.entries()) {
        const found = await collectFiles(
          fileSystem,
          projectRoot,
          directory,
          extensions,
          skipDirectories,
          maxFiles - collected.length,
        );
        if (found.truncated) {
          truncated = true;
        }
        for (const relative of found.files) {
          collected.push({
            name: formatTemplateName({
              namespace: entry.namespace,
              path: relative,
              forcesBundleTemplate: entry.forcesBundleTemplate,
            }),
            projectPath: `${directory}/${relative}`,
            namespace: entry.namespace,
            pathWithinNamespace: relative,
            loaderDirectory: directory,
            forcesBundleTemplate: entry.forcesBundleTemplate,
            directoryPrecedence: precedence,
            shadowed: false,
          });
        }
        if (collected.length >= maxFiles) {
          truncated = true;
          break;
        }
      }
    }

    return new TwigTemplateIndex(...groupTemplates(collected), truncated);
  }

  /** Builds an index directly from entries. Intended for tests. */
  static fromTemplates(templates: readonly IndexedTemplate[]): TwigTemplateIndex {
    return new TwigTemplateIndex(...groupTemplates([...templates]), false);
  }

  /** The copy Twig would actually load, or undefined when nothing provides it. */
  lookup(name: TwigTemplateName | string): IndexedTemplate | undefined {
    const key = typeof name === 'string' ? name : formatTemplateName(name);
    return this.byName.get(key)?.[0];
  }

  /** Every copy providing a name, best first, including shadowed ones. */
  candidatesFor(name: TwigTemplateName | string): readonly IndexedTemplate[] {
    const key = typeof name === 'string' ? name : formatTemplateName(name);
    return this.byName.get(key) ?? [];
  }

  /** True when some directory provides this name. */
  has(name: TwigTemplateName | string): boolean {
    return this.lookup(name) !== undefined;
  }

  /**
   * The names a given file answers to.
   *
   * A file can have several: a directory registered under two namespaces
   * provides the same file under each.
   */
  namesForProjectPath(projectPath: string): readonly string[] {
    const entries = this.byProjectPath.get(projectPath) ?? [];
    return [...new Set(entries.map((entry) => entry.name))];
  }

  /** Every indexed entry for a file, including shadowed ones. */
  templatesForProjectPath(projectPath: string): readonly IndexedTemplate[] {
    return this.byProjectPath.get(projectPath) ?? [];
  }

  /** Every distinct name, sorted, for completion and diagnostics. */
  allNames(): readonly string[] {
    return [...this.byName.keys()].sort();
  }

  /** Names within one namespace, sorted. Pass null for the main namespace. */
  namesInNamespace(namespace: string | null): readonly string[] {
    const names: string[] = [];
    for (const [name, entries] of this.byName) {
      if (entries[0]?.namespace === namespace) {
        names.push(name);
      }
    }
    return names.sort();
  }

  /**
   * Count of distinct template files.
   *
   * Lower than `nameCount`, because one file is reachable under every
   * namespace that covers it: a bundle override answers to `@Twig/x`,
   * `@!Twig/x` and `bundles/TwigBundle/x` alike. This is the count to show a
   * reader who asked how many templates a project has.
   */
  get fileCount(): number {
    return this.byProjectPath.size;
  }

  /** Count of distinct template names, which is what a reference resolves against. */
  get nameCount(): number {
    return this.byName.size;
  }
}

/**
 * Groups entries by name and by file, ordering each name's copies by loader
 * precedence and marking everything after the winner as shadowed.
 */
function groupTemplates(
  templates: IndexedTemplate[],
): [ReadonlyMap<string, readonly IndexedTemplate[]>, ReadonlyMap<string, readonly IndexedTemplate[]>] {
  const byName = new Map<string, IndexedTemplate[]>();
  for (const template of templates) {
    const existing = byName.get(template.name);
    if (existing === undefined) {
      byName.set(template.name, [template]);
    } else {
      existing.push(template);
    }
  }

  const byProjectPath = new Map<string, IndexedTemplate[]>();
  for (const [name, entries] of byName) {
    entries.sort((a, b) => a.directoryPrecedence - b.directoryPrecedence);
    const ordered = entries.map((entry, position) => ({ ...entry, shadowed: position > 0 }));
    byName.set(name, ordered);

    for (const entry of ordered) {
      const forPath = byProjectPath.get(entry.projectPath);
      if (forPath === undefined) {
        byProjectPath.set(entry.projectPath, [entry]);
      } else {
        forPath.push(entry);
      }
    }
  }

  return [byName, byProjectPath];
}

/** Recursively lists files below a loader directory, relative to it. */
async function collectFiles(
  fileSystem: WickerFileSystem,
  projectRoot: string,
  loaderDirectory: string,
  extensions: readonly string[],
  skipDirectories: ReadonlySet<string>,
  remaining: number,
): Promise<{ files: readonly string[]; truncated: boolean }> {
  if (remaining <= 0) {
    return { files: [], truncated: true };
  }

  const files: string[] = [];
  let truncated = false;
  const absoluteOf = (relative: string): string => joinProjectPath(
    projectRoot,
    relative === '' ? loaderDirectory : `${loaderDirectory}/${relative}`,
  );

  /*
   * A level at a time, listing the directories in each level together.
   *
   * Every listing is a round trip, and descending one directory at a time made
   * the wait as long as the tree has directories. A template tree is wide and
   * shallow, so reading each level at once turns most of that into waiting
   * once per level.
   */
  let level = [''];
  while (level.length > 0 && !truncated) {
    const next: string[] = [];
    for (let at = 0; at < level.length && !truncated; at += LISTINGS_AT_ONCE) {
      const listings = await Promise.all(level.slice(at, at + LISTINGS_AT_ONCE).map(
        async (directory) => ({ directory, entries: await fileSystem.readDirectory(absoluteOf(directory)) })));
      for (const { directory, entries } of listings) {
        for (const entry of entries) {
          if (files.length >= remaining) {
            truncated = true;
            break;
          }
          const relative = directory === '' ? entry.name : `${directory}/${entry.name}`;
          if (entry.type === 'directory') {
            if (!skipDirectories.has(entry.name)) { next.push(relative); }
          } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
            files.push(relative);
          }
        }
        if (truncated) { break; }
      }
    }
    level = next;
  }
  return { files, truncated };
}

/** Directory listings to request together. Enough to hide the latency of one,
 * without opening an unbounded number of handles on a large tree. */
const LISTINGS_AT_ONCE = 16;
