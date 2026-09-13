import type * as vscode from 'vscode';

import type { LoaderPathEntry } from '@wicker/core';

/**
 * Remembers what `bin/console debug:twig` last said about a project.
 *
 * Bundle namespaces exist nowhere in configuration, so without the console
 * they cannot be discovered at all. Asking on every start and keeping no
 * record optimises for the rare case, a bundle being installed, at the cost
 * of the common one: the container is not running yet, or has just restarted,
 * and the editor briefly reports correct code as broken.
 *
 * The stored value is a list of namespaces and project-relative directories.
 * It holds nothing about the machine it came from, so it stays valid across a
 * container rebuild and travels with the workspace.
 */

/**
 * Bumped when the stored shape changes, so an old record is ignored rather
 * than misread. Entries are re-derived on the next successful console run.
 */
const KEY_PREFIX = 'wicker.loaderPaths.v1:';

export class LoaderPathMemory {
  constructor(private readonly store: vscode.Memento) {}

  /** The last console answer for a project, if one was stored and still reads. */
  read(projectRoot: string): readonly LoaderPathEntry[] | undefined {
    const stored = this.store.get<unknown>(KEY_PREFIX + projectRoot);
    if (!Array.isArray(stored)) {
      return undefined;
    }

    const entries = stored.filter(isLoaderPathEntry);
    // A partially readable record is not used: half a namespace list would
    // resolve some references and silently fail others, which is worse than
    // falling back to configuration and saying so.
    if (entries.length !== stored.length || entries.length === 0) {
      return undefined;
    }
    return entries;
  }

  /** Records a console answer. Callers pass only what the console produced. */
  async write(projectRoot: string, entries: readonly LoaderPathEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.store.update(KEY_PREFIX + projectRoot, entries);
  }

  /** Forgets a project's answer, so the next run starts from the console. */
  async forget(projectRoot: string): Promise<void> {
    await this.store.update(KEY_PREFIX + projectRoot, undefined);
  }
}

/**
 * Whether a stored value still matches the shape this version reads.
 *
 * The store survives extension upgrades and can be edited by hand, so what
 * comes back is untrusted input rather than something the type says it is.
 */
function isLoaderPathEntry(value: unknown): value is LoaderPathEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<LoaderPathEntry>;
  return (
    (candidate.namespace === null || typeof candidate.namespace === 'string') &&
    typeof candidate.forcesBundleTemplate === 'boolean' &&
    Array.isArray(candidate.directories) &&
    candidate.directories.every((directory) => typeof directory === 'string')
  );
}
