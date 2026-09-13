/**
 * Path conventions for the Wicker engine.
 *
 * Two kinds of path exist here and they are never mixed:
 *
 *   - A **root path** is absolute and belongs to whatever machine the engine
 *     runs on: `F:/GitHub/app`, `/app`, `//wsl.localhost/Ubuntu/home/w/app`.
 *   - A **project path** is relative to that root, always forward-slashed, and
 *     never starts with a slash: `templates/home/index.html.twig`.
 *
 * Everything the engine indexes, compares, or reports is a project path. That
 * is what lets one index be valid whether Symfony sees the project at `/app`
 * inside its container while the editor sees it on a Windows drive, and it is
 * why `debug:twig` reporting relative loader paths is so convenient.
 */

import posix from 'node:path/posix';

/** Converts Windows separators to forward slashes. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Normalizes an absolute root: forward slashes, no trailing slash.
 *
 * A lone `/` and a drive root such as `F:/` keep their trailing slash, because
 * removing it would change what the path means.
 */
export function normalizeRootPath(root: string): string {
  const posixRoot = toPosixPath(root);
  const collapsed = posixRoot.replace(/(?<!^)\/{2,}/g, '/');
  if (collapsed === '/' || /^[A-Za-z]:\/$/.test(collapsed)) {
    return collapsed;
  }
  return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

/**
 * Normalizes a project-relative path.
 *
 * Returns undefined when the input is not a usable project path, which covers
 * absolute paths and anything escaping the root. Callers treat undefined as
 * "this does not name a file inside the project" rather than as an error.
 */
export function normalizeProjectPath(value: string): string | undefined {
  const posixValue = toPosixPath(value).replace(/\/{2,}/g, '/');
  if (posixValue.length === 0) {
    return undefined;
  }
  if (posixValue.startsWith('/') || /^[A-Za-z]:/.test(posixValue)) {
    return undefined;
  }

  const segments: string[] = [];
  for (const segment of posixValue.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.length === 0 ? undefined : segments.join('/');
}

/** Joins a normalized root and a project path into an absolute path. */
export function joinProjectPath(root: string, projectPath: string): string {
  const normalizedRoot = normalizeRootPath(root);
  return normalizedRoot.endsWith('/')
    ? `${normalizedRoot}${projectPath}`
    : `${normalizedRoot}/${projectPath}`;
}

/**
 * Expresses an absolute path relative to a root, or undefined when it lies
 * outside. Comparison is case-insensitive on Windows-style drive paths, where
 * the same file is reachable as `F:/x` and `f:/X`.
 */
export function toProjectPath(root: string, absolutePath: string): string | undefined {
  const normalizedRoot = normalizeRootPath(root);
  const normalizedTarget = normalizeRootPath(absolutePath);

  const windowsStyle = /^[A-Za-z]:/.test(normalizedRoot);
  const comparableRoot = windowsStyle ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableTarget = windowsStyle ? normalizedTarget.toLowerCase() : normalizedTarget;

  if (comparableTarget === comparableRoot) {
    return undefined;
  }

  const prefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
  if (!comparableTarget.startsWith(prefix)) {
    return undefined;
  }

  return normalizeProjectPath(normalizedTarget.slice(prefix.length));
}

/**
 * The parent of an absolute path, or undefined when it is already a root.
 *
 * Roots are `/` for posix, `F:/` for a Windows drive, and `//server/share` for
 * a UNC path such as the one a WSL project is reached through.
 */
export function parentDirectory(absolutePath: string): string | undefined {
  const normalized = normalizeRootPath(absolutePath);
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return undefined;
  }

  // A UNC share root (//server/share) has no parent Wicker should climb into.
  const uncMatch = /^\/\/[^/]+\/[^/]+$/.exec(normalized);
  if (uncMatch !== null) {
    return undefined;
  }

  const separator = normalized.lastIndexOf('/');
  if (separator === -1) {
    return undefined;
  }
  if (separator === 0) {
    return '/';
  }
  const parent = normalized.slice(0, separator);
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}/`;
  }
  if (parent === '/') {
    return '/';
  }
  return parent;
}

/** Every ancestor directory of an absolute path, nearest first. */
export function ancestorDirectories(absolutePath: string): readonly string[] {
  const ancestors: string[] = [];
  let cursor = parentDirectory(absolutePath);
  while (cursor !== undefined) {
    ancestors.push(cursor);
    cursor = parentDirectory(cursor);
  }
  return ancestors;
}

/** Directory portion of a project path, or undefined at the top level. */
export function projectPathDirname(projectPath: string): string | undefined {
  const parent = posix.dirname(projectPath);
  return parent === '.' || parent === '/' ? undefined : parent;
}

/** Final segment of a project path. */
export function projectPathBasename(projectPath: string): string {
  return posix.basename(projectPath);
}

/**
 * True when `candidate` sits at or below `directory`, both project paths.
 *
 * Segment-aware, so `templates2/x` is not treated as living under `templates`.
 */
export function isWithinDirectory(candidate: string, directory: string): boolean {
  if (directory.length === 0) {
    return true;
  }
  return candidate === directory || candidate.startsWith(`${directory}/`);
}
