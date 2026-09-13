import { ancestorDirectories, normalizeRootPath } from '../util/paths.js';

import type { DirectoryEntry, FileStat, WickerFileSystem } from './fileSystem.js';

/**
 * An in-memory filesystem for tests and for modelling a project that has not
 * been written to disk.
 *
 * Directories are implied by the files inside them, so a fixture is just a map
 * of path to contents. Explicit empty directories can still be declared when a
 * test needs one, for example to prove that an empty `templates/` is handled.
 *
 * Path comparison follows the same rule as the rest of the engine: Windows
 * drive paths compare case-insensitively, posix paths do not.
 */
export class InMemoryFileSystem implements WickerFileSystem {
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();

  constructor(files: Readonly<Record<string, string>> = {}) {
    for (const [path, contents] of Object.entries(files)) {
      this.writeFile(path, contents);
    }
  }

  /** Adds or replaces a file, creating its parent directories. */
  writeFile(absolutePath: string, contents: string): void {
    const key = this.key(absolutePath);
    this.files.set(key, contents);
    for (const parent of ancestorDirectories(key)) {
      this.directories.add(parent);
    }
  }

  /** Declares a directory that contains no files. */
  makeDirectory(absolutePath: string): void {
    const key = this.key(absolutePath);
    this.directories.add(key);
    for (const parent of ancestorDirectories(key)) {
      this.directories.add(parent);
    }
  }

  /** Removes a file. Returns true when something was removed. */
  deleteFile(absolutePath: string): boolean {
    return this.files.delete(this.key(absolutePath));
  }

  readFile(absolutePath: string): Promise<string | undefined> {
    return Promise.resolve(this.files.get(this.key(absolutePath)));
  }

  stat(absolutePath: string): Promise<FileStat | undefined> {
    const key = this.key(absolutePath);
    if (this.files.has(key)) {
      return Promise.resolve({ type: 'file' });
    }
    if (this.directories.has(key)) {
      return Promise.resolve({ type: 'directory' });
    }
    return Promise.resolve(undefined);
  }

  readDirectory(absolutePath: string): Promise<readonly DirectoryEntry[]> {
    const key = this.key(absolutePath);
    if (!this.directories.has(key)) {
      return Promise.resolve([]);
    }

    const prefix = key.endsWith('/') ? key : `${key}/`;
    const seen = new Map<string, DirectoryEntry>();

    for (const filePath of this.files.keys()) {
      const child = childSegment(filePath, prefix);
      if (child !== undefined && !seen.has(child.name)) {
        seen.set(child.name, child);
      }
    }
    for (const directoryPath of this.directories) {
      const child = childSegment(directoryPath, prefix);
      if (child !== undefined) {
        // A declared directory wins over an inferred file entry of the same
        // name, which cannot legally coexist anyway.
        seen.set(child.name, { name: child.name, type: 'directory' });
      }
    }

    return Promise.resolve([...seen.values()]);
  }

  private key(absolutePath: string): string {
    const normalized = normalizeRootPath(absolutePath);
    return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
  }
}

/**
 * If `path` lies under `prefix`, describes its immediate child segment: a file
 * when the path terminates there, a directory when it continues deeper.
 */
function childSegment(path: string, prefix: string): DirectoryEntry | undefined {
  if (!path.startsWith(prefix) || path.length === prefix.length) {
    return undefined;
  }
  const remainder = path.slice(prefix.length);
  const separator = remainder.indexOf('/');
  if (separator === -1) {
    return { name: remainder, type: 'file' };
  }
  return { name: remainder.slice(0, separator), type: 'directory' };
}
