import { promises as fs } from 'node:fs';

import type { DirectoryEntry, FileStat, WickerFileSystem } from './fileSystem.js';

/**
 * Real-disk implementation.
 *
 * Node accepts forward slashes on Windows, so the engine's posix-normalized
 * paths are passed straight through with no per-platform branching.
 */
export class NodeFileSystem implements WickerFileSystem {
  async readFile(absolutePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(absolutePath, 'utf8');
    } catch (error) {
      if (isMissingOrUnreadable(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async stat(absolutePath: string): Promise<FileStat | undefined> {
    try {
      const stats = await fs.stat(absolutePath);
      if (stats.isDirectory()) {
        return { type: 'directory' };
      }
      if (stats.isFile()) {
        return { type: 'file' };
      }
      // Sockets, FIFOs and the like are not things Wicker indexes.
      return undefined;
    } catch (error) {
      if (isMissingOrUnreadable(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async readDirectory(absolutePath: string): Promise<readonly DirectoryEntry[]> {
    let entries;
    try {
      entries = await fs.readdir(absolutePath, { withFileTypes: true });
    } catch (error) {
      if (isMissingOrUnreadable(error)) {
        return [];
      }
      throw error;
    }

    const result: DirectoryEntry[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        result.push({ name: entry.name, type: 'directory' });
      } else if (entry.isFile()) {
        result.push({ name: entry.name, type: 'file' });
      }
      // Symlinks report as neither; they are resolved by a follow-up stat only
      // when something actually asks for the entry, so a broken link in
      // vendor/ cannot abort an index build.
    }
    return result;
  }
}

/**
 * Errors that mean "there is nothing usable here", as opposed to a real fault.
 *
 * ENOTDIR appears when a path component is a file, which happens routinely
 * while probing candidate template paths. EPERM and EACCES appear on Windows
 * for locked or protected entries and should not abort an index build.
 */
function isMissingOrUnreadable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'EISDIR' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ELOOP' ||
    code === 'ENAMETOOLONG'
  );
}
