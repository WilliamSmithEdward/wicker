/**
 * Reading of `composer.json`, limited to what Wicker actually needs: how the
 * project identifies itself, which Symfony packages it requires, and the PSR-4
 * map that turns a class name into a file and back.
 *
 * The file is parsed defensively. It is authored by hand, may be mid-edit when
 * the editor asks, and a malformed manifest must degrade the feature set rather
 * than take the engine down.
 */

import { normalizeProjectPath } from '../util/paths.js';

export interface Psr4Mapping {
  /** Namespace prefix including its trailing separator, e.g. `App\`. */
  readonly prefix: string;
  /** Project-relative directories the prefix maps onto, in declared order. */
  readonly directories: readonly string[];
}

export interface ComposerManifest {
  readonly name: string | undefined;
  readonly type: string | undefined;
  /** Merged `require` and `require-dev`, package name to version constraint. */
  readonly requirements: ReadonlyMap<string, string>;
  /** Merged `autoload.psr-4` and `autoload-dev.psr-4`, longest prefix first. */
  readonly psr4: readonly Psr4Mapping[];
}

const EMPTY_MANIFEST: ComposerManifest = {
  name: undefined,
  type: undefined,
  requirements: new Map(),
  psr4: [],
};

/**
 * Parses composer.json. Returns undefined only when the text is not valid JSON
 * or not a JSON object; missing or malformed individual keys are skipped so a
 * partially broken manifest still yields whatever it does declare.
 */
export function parseComposerManifest(raw: string): ComposerManifest | undefined {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }

  const root = document as Record<string, unknown>;
  const requirements = new Map<string, string>();
  for (const key of ['require', 'require-dev']) {
    for (const [name, constraint] of readStringRecord(root[key])) {
      requirements.set(name, constraint);
    }
  }

  const psr4: Psr4Mapping[] = [];
  for (const key of ['autoload', 'autoload-dev']) {
    const section = root[key];
    if (typeof section !== 'object' || section === null) {
      continue;
    }
    psr4.push(...readPsr4((section as Record<string, unknown>)['psr-4']));
  }

  return {
    ...EMPTY_MANIFEST,
    name: readString(root['name']),
    type: readString(root['type']),
    requirements,
    // Longest prefix first, so `App\Tests\` wins over `App\` when both match.
    psr4: psr4.sort((a, b) => b.prefix.length - a.prefix.length),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readStringRecord(value: unknown): readonly (readonly [string, string])[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  const pairs: (readonly [string, string])[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      pairs.push([key, entry]);
    }
  }
  return pairs;
}

function readPsr4(value: unknown): Psr4Mapping[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }

  const mappings: Psr4Mapping[] = [];
  for (const [prefix, target] of Object.entries(value as Record<string, unknown>)) {
    const rawDirectories = Array.isArray(target) ? target : [target];
    const directories: string[] = [];
    for (const directory of rawDirectories) {
      if (typeof directory !== 'string') {
        continue;
      }
      // An empty target means the project root, which normalizes to nothing.
      const normalized = directory === '' ? '' : normalizeProjectPath(directory);
      if (normalized !== undefined) {
        directories.push(normalized);
      }
    }
    if (directories.length > 0) {
      mappings.push({ prefix, directories });
    }
  }
  return mappings;
}

/** True when the manifest requires the given package in either require block. */
export function requiresPackage(manifest: ComposerManifest, packageName: string): boolean {
  return manifest.requirements.has(packageName);
}

/** Packages required under the `symfony/` vendor, sorted for stable display. */
export function symfonyPackages(manifest: ComposerManifest): readonly string[] {
  return [...manifest.requirements.keys()].filter((name) => name.startsWith('symfony/')).sort();
}

/**
 * Maps a fully qualified class name onto candidate project paths.
 *
 * `App\Controller\HomeController` with `App\ => src/` yields
 * `src/Controller/HomeController.php`. Every PSR-4 directory registered for the
 * winning prefix is offered, in declared order, because the class may live in
 * any of them.
 */
export function classToProjectPaths(
  manifest: ComposerManifest,
  fullyQualifiedClassName: string,
): readonly string[] {
  const className = fullyQualifiedClassName.replace(/^\\+/, '');
  if (className.length === 0) {
    return [];
  }

  for (const mapping of manifest.psr4) {
    if (!className.startsWith(mapping.prefix)) {
      continue;
    }
    const relativeClass = className.slice(mapping.prefix.length);
    if (relativeClass.length === 0) {
      continue;
    }
    const relativePath = `${relativeClass.split('\\').join('/')}.php`;
    return mapping.directories.map((directory) =>
      directory === '' ? relativePath : `${directory}/${relativePath}`,
    );
  }
  return [];
}

/**
 * The inverse mapping: a project path back to the class it must declare.
 *
 * Returns undefined when the path is not a PHP file below any PSR-4 root.
 */
export function projectPathToClass(
  manifest: ComposerManifest,
  projectPath: string,
): string | undefined {
  const normalized = normalizeProjectPath(projectPath);
  if (normalized === undefined || !normalized.endsWith('.php')) {
    return undefined;
  }
  const withoutExtension = normalized.slice(0, -'.php'.length);

  let best: { prefix: string; relative: string; directoryLength: number } | undefined;
  for (const mapping of manifest.psr4) {
    for (const directory of mapping.directories) {
      const isRootMapping = directory === '';
      if (!isRootMapping && !withoutExtension.startsWith(`${directory}/`)) {
        continue;
      }
      const relative = isRootMapping
        ? withoutExtension
        : withoutExtension.slice(directory.length + 1);
      if (relative.length === 0) {
        continue;
      }
      // Prefer the deepest matching directory: with both `App\ => src` and
      // `App\Tests\ => src/Tests`, a file under src/Tests belongs to the latter.
      if (best === undefined || directory.length > best.directoryLength) {
        best = { prefix: mapping.prefix, relative, directoryLength: directory.length };
      }
    }
  }

  if (best === undefined) {
    return undefined;
  }
  return `${best.prefix}${best.relative.split('/').join('\\')}`;
}
