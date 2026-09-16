import type * as vscode from 'vscode';

import { TemplateContextIndex, type TwigTemplateIndex } from '@wicker/core';

import { readInBatches, type KnownSources, type VsCodeFileSystem } from './fileSystem.js';
import { enginePathOf } from './paths.js';
import { SourceTracker } from './sourceTracker.js';

/** Twig text stays current independently of console discovery and template-name indexing. */
export class TemplateContextTracker extends SourceTracker {
  readonly index = new TemplateContextIndex();
  private known = new Set<string>();

  constructor(root: string, fileSystem: VsCodeFileSystem,
    private readonly relativePath: (absolute: string) => string | undefined) {
    super(root, fileSystem, '**/*.twig');
  }

  /** Read new loader files; watcher events maintain files already loaded. */
  async refresh(templates: TwigTemplateIndex, force = false, known?: KnownSources): Promise<void> {
    const paths = new Set(templates.allNames().flatMap((name) => templates.candidatesFor(name).map((entry) => entry.projectPath)));
    for (const path of this.known) {
      if (!paths.has(path)) { this.drop(path); }
    }
    const added = [...paths].filter((path) => force || !this.known.has(path));
    this.known = paths;
    // Smaller batches than the other trackers: a template carries its whole
    // inheritance chain into the parse, so these reads are the heavier ones.
    await readInBatches(added, (path) => this.load(path, known), () => this.disposed, 64);
  }

  protected pathOf(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== this.rootUri.scheme || uri.authority !== this.rootUri.authority) { return undefined; }
    const path = this.relativePath(enginePathOf(uri));
    return path?.endsWith('.twig') ? path : undefined;
  }

  /** Only the files the loader paths reach; a .twig anywhere else is not a template. */
  protected override watches(path: string): boolean { return this.known.has(path); }

  protected set(path: string, source: string): void { this.index.update(path, source); }

  protected remove(path: string): void { this.index.remove(path); }
}
