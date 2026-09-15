import type * as vscode from 'vscode';

import { normalizeRootPath } from '@wicker/core';

/**
 * The engine's path form for a URI.
 *
 * `Uri.path` is the wrong source on Windows: for `F:\project` it yields
 * `/f:/project`, with a leading slash and a lowercased drive. The engine then
 * sees a path that is neither posix nor Windows, its drive-aware comparisons
 * never engage, and `Uri.file` cannot round-trip it back.
 *
 * `fsPath` gives the platform's own form, which is what the engine normalizes
 * cleanly, and on a remote or container workspace it is already posix. Only
 * non-file schemes, where `fsPath` is not meaningful, fall back to `path`.
 */
export function enginePathOf(uri: vscode.Uri): string {
  return normalizeRootPath(uri.scheme === 'file' ? uri.fsPath : uri.path);
}

/**
 * Directories a scan of a project's own sources does not descend into.
 *
 * Named once, with the search filter and the path test both derived from it.
 * Written separately they drift, and the drift is silent in the worst
 * direction: a widened glob whose path guard still rejects the new files finds
 * nothing and looks like the feature simply does not work.
 *
 * `vendor` belongs here because these scans read what the project itself
 * wrote. Bundle templates and packaged controllers are still reached, through
 * the loader paths and the console, rather than by walking the tree.
 */
const IGNORED_DIRECTORIES = ['vendor', 'var', 'node_modules', '.git'] as const;

/** The exclude pattern for `findFiles`. */
export const IGNORED_GLOB = `{${IGNORED_DIRECTORIES.map((name) => `**/${name}/**`).join(',')}}`;

const IGNORED = new Set<string>(IGNORED_DIRECTORIES);

/** Whether a project-relative path passes through one of them. */
export function inIgnoredDirectory(projectPath: string): boolean {
  return projectPath.split('/').some((segment) => IGNORED.has(segment));
}
