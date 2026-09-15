/**
 * The AssetMapper side of the bridge: which files a template can actually ask
 * for, and what to call them.
 *
 * `asset('styles/app.css')` names a logical path, not a file path. AssetMapper
 * resolves it against a set of configured roots, each with an optional
 * namespace, and serves it under a hashed URL that appears nowhere in the
 * source. Nothing in a template says where `styles/app.css` lives, or whether
 * it exists at all.
 *
 * Symfony reports the configuration as JSON but has no JSON form of the asset
 * map itself, so the roots are read from the console and walked here. That
 * keeps the result project-relative, which is what lets one index be valid
 * whether Symfony sees `/app` or the editor sees a Windows drive.
 */

import type { WickerFileSystem } from '../fs/fileSystem.js';
import { joinProjectPath, normalizeProjectPath, projectPathBasename, toProjectPath } from '../util/paths.js';

/** One configured directory and the prefix its assets answer to. */
export interface AssetRoot {
  readonly directory: string;
  /** `@symfony/ux-turbo`, or empty for the application's own assets. */
  readonly namespace: string;
}

export interface AssetMapperSettings {
  readonly roots: readonly AssetRoot[];
  readonly excludedPatterns: readonly string[];
  readonly excludeDotfiles: boolean;
  /** Where the compiled assets are served from, `/assets/` by default. */
  readonly publicPrefix: string;
}

export interface MappedAsset {
  readonly logicalPath: string;
  readonly projectPath: string;
}

const DEFAULT_MAX_FILES = 20_000;
const SKIP_DIRECTORIES: readonly string[] = ['.git', 'node_modules'];

/**
 * Reads `debug:config framework asset_mapper --format=json`.
 *
 * The reported directories are a mixture: some absolute inside the container,
 * some relative to the project, and the absolute ones arrive uncollapsed, as
 * `.../src/DependencyInjection/../../assets/dist`. Both forms are reduced to
 * one project-relative path. A root that resolves outside the project is
 * dropped rather than guessed at.
 */
export function assetMapperSettings(payload: unknown, runtimeRoot: string): AssetMapperSettings | undefined {
  const config = asObject(payload);
  const paths = asObject(config?.['paths']);
  if (!config || !paths) {
    return undefined;
  }

  const roots: AssetRoot[] = [];
  for (const [directory, namespace] of Object.entries(paths)) {
    const relative = toProjectPath(runtimeRoot, directory) ?? normalizeProjectPath(directory);
    if (relative !== undefined && typeof namespace === 'string') {
      roots.push({ directory: relative, namespace });
    }
  }

  const patterns = config['excluded_patterns'];
  return {
    roots,
    excludedPatterns: Array.isArray(patterns) ? patterns.filter((value): value is string => typeof value === 'string') : [],
    excludeDotfiles: config['exclude_dotfiles'] !== false,
    publicPrefix: typeof config['public_prefix'] === 'string' ? config['public_prefix'] : '/assets/',
  };
}

/**
 * The name a template would use for a file, or undefined when no root covers
 * it.
 *
 * Roots can nest: `assets/` and a bundle directory inside `vendor/` do not,
 * but a project is free to configure one inside another. The longest matching
 * directory wins, because that is the one whose namespace the file answers to.
 */
export function assetLogicalPath(roots: readonly AssetRoot[], projectPath: string): string | undefined {
  const covering = roots
    .filter((root) => projectPath === root.directory || projectPath.startsWith(`${root.directory}/`))
    .sort((left, right) => right.directory.length - left.directory.length)[0];
  if (covering === undefined) {
    return undefined;
  }
  const relative = projectPath.slice(covering.directory.length + 1);
  return covering.namespace === '' ? relative : `${covering.namespace}/${relative}`;
}

/**
 * Whether AssetMapper would leave a file out of the map.
 *
 * The patterns are the glob subset Symfony actually ships in this setting:
 * `*.d.ts` and `*&#47;controllers.json`. `*` matches within a segment and the
 * match is against the path relative to its root, which is what the
 * configuration describes.
 */
export function assetExcluded(settings: AssetMapperSettings, relativePath: string): boolean {
  if (settings.excludeDotfiles && relativePath.split('/').some((segment) => segment.startsWith('.'))) {
    return true;
  }
  return settings.excludedPatterns.some((pattern) => globMatches(pattern, relativePath));
}

/** Logical path to file, and back again. */
export class AssetMap {
  private readonly byLogicalPath: ReadonlyMap<string, MappedAsset>;
  private readonly byProjectPath: ReadonlyMap<string, MappedAsset>;
  /** True when the walk stopped early, so callers know the map is partial. */
  readonly truncated: boolean;

  private constructor(assets: readonly MappedAsset[], truncated: boolean) {
    this.byLogicalPath = new Map(assets.map((asset) => [asset.logicalPath, asset]));
    this.byProjectPath = new Map(assets.map((asset) => [asset.projectPath, asset]));
    this.truncated = truncated;
  }

  static empty(): AssetMap {
    return new AssetMap([], false);
  }

  static fromAssets(assets: readonly MappedAsset[], truncated = false): AssetMap {
    return new AssetMap(assets, truncated);
  }

  /** Walks the configured roots. Bounded, because a root can be a whole vendor tree. */
  static async build(
    fileSystem: WickerFileSystem,
    projectRoot: string,
    settings: AssetMapperSettings,
    options: { readonly maxFiles?: number } = {},
  ): Promise<AssetMap> {
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const assets: MappedAsset[] = [];
    const seen = new Set<string>();
    let count = 0;
    let truncated = false;

    for (const root of settings.roots) {
      const visit = async (directory: string): Promise<void> => {
        if (truncated) {
          return;
        }
        const entries = [...await fileSystem.readDirectory(joinProjectPath(projectRoot, directory))]
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const child = `${directory}/${entry.name}`;
          if (entry.type === 'directory') {
            if (SKIP_DIRECTORIES.includes(entry.name)) { continue; }
            await visit(child);
            if (truncated) { return; }
            continue;
          }
          if (++count > maxFiles) { truncated = true; return; }
          const relative = child.slice(root.directory.length + 1);
          if (assetExcluded(settings, relative)) { continue; }
          const logicalPath = root.namespace === '' ? relative : `${root.namespace}/${relative}`;
          // A file reachable through two roots keeps the first name, matching
          // the order the configuration lists them in.
          if (seen.has(logicalPath)) { continue; }
          seen.add(logicalPath);
          assets.push({ logicalPath, projectPath: child });
        }
      };
      await visit(root.directory);
    }

    return new AssetMap(assets, truncated);
  }

  /**
   * The asset a reference names, ignoring anything addressing part of it.
   *
   * `asset('icons.svg#pin')` and `url('font.woff2?v=2')` both name a file the
   * map holds, with a fragment selecting a symbol inside it and a query
   * busting a cache. Matching those literally finds nothing and makes a
   * perfectly good reference look broken.
   */
  lookup(logicalPath: string): MappedAsset | undefined {
    const direct = this.byLogicalPath.get(logicalPath);
    if (direct) { return direct; }
    const bare = logicalPath.replace(/[?#].*$/, '');
    return bare === logicalPath ? undefined : this.byLogicalPath.get(bare);
  }

  /** The name a file answers to, for the reverse direction. */
  forProjectPath(projectPath: string): MappedAsset | undefined {
    return this.byProjectPath.get(projectPath);
  }

  /** Every logical path, sorted, for completion. */
  logicalPaths(): readonly string[] {
    return [...this.byLogicalPath.keys()].sort();
  }

  get size(): number {
    return this.byLogicalPath.size;
  }
}

/**
 * Compiled once per pattern.
 *
 * The asset walk asks every configured pattern about every file it finds, and
 * the patterns do not change, so building the expression per file was the same
 * work repeated for as many assets as a project has.
 */
const globs = new Map<string, RegExp>();

/** `*` within a segment, `**` across them. Nothing else is supported. */
function globPattern(pattern: string): RegExp {
  let compiled = globs.get(pattern);
  if (compiled === undefined) {
    const expression = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      // Both stars in one pass, so `**` is consumed before `*` can see it.
      // This used to substitute a placeholder for `**` and put it back
      // afterwards, and the placeholder was a literal NUL byte written into
      // the source: invisible in a diff, and enough for git and grep to treat
      // the whole file as binary.
      .replace(/\*\*|\*/g, (star) => star === '**' ? '.*' : '[^/]*');
    compiled = new RegExp(`^${expression}$`);
    globs.set(pattern, compiled);
  }
  return compiled;
}

function globMatches(pattern: string, value: string): boolean {
  const expression = globPattern(pattern);
  // Anchored, but a pattern with no slash matches a bare filename anywhere,
  // which is how "*.d.ts" is meant to read.
  return expression.test(value) ||
    (!pattern.includes('/') && expression.test(projectPathBasename(value)));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
