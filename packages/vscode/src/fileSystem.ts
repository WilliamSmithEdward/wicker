import * as vscode from 'vscode';

import type { DirectoryEntry, FileStat, WickerFileSystem } from '@wicker/core';
import { normalizeRootPath, toProjectPath } from '@wicker/core';

import { enginePathOf } from './paths.js';

const decoder = new TextDecoder('utf-8');

/**
 * Text already read during this rebuild, if any.
 *
 * Three indexes cover overlapping files: the render sites read every PHP file,
 * the template contexts every template, and the frontend sources both plus the
 * scripts and stylesheets. Each used to read from disk itself, so a project's
 * PHP and Twig were read twice to build it once. Reading through the editor
 * costs about five times what node does, and about half what parsing the same
 * file costs, so the second read is not free.
 *
 * Undefined means nothing has read it yet and the caller should, which is also
 * what a watcher event gets, since it concerns one file that has just changed.
 */
export type KnownSources = (projectPath: string) => string | undefined;

/**
 * Reads a set of files a few at a time, stopping when the caller goes away.
 *
 * Every tracker rebuilds by reading its whole file set, and issuing all of
 * those at once floods a container or a connection where each read is a round
 * trip. Each tracker hand-rolled the same index arithmetic and the same
 * disposal check, which is a loop that is easy to write slightly differently
 * three times and hard to notice when one of them stops checking.
 *
 * A read through the editor's file service is mostly waiting, so what matters
 * is how many are in flight at once. Measured in the extension host: 433us a
 * read one at a time, 174us at eight, 114us at thirty-two, 86us at a hundred
 * and twenty-eight. Over a remote connection the wait is longer and the share
 * of it that overlapping recovers is larger.
 */
export async function readInBatches<T>(
  items: readonly T[],
  read: (item: T) => Promise<void>,
  abandoned: () => boolean,
  size = 128,
): Promise<void> {
  for (let start = 0; start < items.length && !abandoned(); start += size) {
    await Promise.all(items.slice(start, start + size).map(read));
  }
}

/**
 * The engine's filesystem, backed by `vscode.workspace.fs`.
 *
 * Going through the editor rather than `node:fs` is what lets the same code
 * work when the workspace is not on local disk: a dev container, a remote SSH
 * host, or a virtual filesystem contributed by another extension.
 *
 * Child URIs are derived from the workspace folder's own URI rather than
 * rebuilt with `Uri.file`, so the scheme and authority of a remote workspace
 * survive the round trip.
 */
export class VsCodeFileSystem implements WickerFileSystem {
  private readonly rootUri: vscode.Uri;
  private readonly rootPath: string;

  constructor(rootUri: vscode.Uri) {
    this.rootUri = rootUri;
    this.rootPath = enginePathOf(rootUri);
  }

  async readFile(absolutePath: string): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.toUri(absolutePath));
      return decoder.decode(bytes);
    } catch {
      // Missing, unreadable, or a directory. All mean "nothing to read here",
      // which is the ordinary case when probing a candidate path.
      return undefined;
    }
  }

  async stat(absolutePath: string): Promise<FileStat | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(this.toUri(absolutePath));
      if ((stat.type & vscode.FileType.Directory) !== 0) {
        return { type: 'directory' };
      }
      if ((stat.type & vscode.FileType.File) !== 0) {
        return { type: 'file' };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async readDirectory(absolutePath: string): Promise<readonly DirectoryEntry[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.toUri(absolutePath));
    } catch {
      return [];
    }

    const result: DirectoryEntry[] = [];
    for (const [name, type] of entries) {
      if ((type & vscode.FileType.Directory) !== 0) {
        result.push({ name, type: 'directory' });
      } else if ((type & vscode.FileType.File) !== 0) {
        result.push({ name, type: 'file' });
      }
    }
    return result;
  }

  /** Builds a URI for a path, keeping the workspace's scheme and authority. */
  toUri(absolutePath: string): vscode.Uri {
    const relative = toProjectPath(this.rootPath, absolutePath);
    if (relative === undefined) {
      return normalizeRootPath(absolutePath) === this.rootPath
        ? this.rootUri
        : vscode.Uri.file(absolutePath);
    }
    return vscode.Uri.joinPath(this.rootUri, ...relative.split('/'));
  }
}
