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
