import * as vscode from 'vscode';

import { RenderSiteIndex } from '@wicker/core';

import { readInBatches, type KnownSources, type VsCodeFileSystem } from './fileSystem.js';
import { inIgnoredDirectory, IGNORED_GLOB } from './paths.js';
import { SourceTracker } from './sourceTracker.js';

/** Maintains disk records with open PHP buffers taking precedence, even before saving. */
export class RenderSiteTracker extends SourceTracker {
  readonly index = new RenderSiteIndex();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(root: string, fileSystem: VsCodeFileSystem) { super(root, fileSystem, '**/*.php'); }

  /**
   * Reads every PHP file, or every file in `found` when the caller has already
   * searched. The frontend tracker enumerates the same files under the same
   * exclusions moments earlier, and a workspace search is the one cost here
   * that grows with the repository rather than with the project.
   */
  async refresh(known?: KnownSources, found?: readonly vscode.Uri[]): Promise<void> {
    // Include old paths so a rebuild also removes deleted sources, and open
    // buffers so an unsaved file is never replaced by its older disk contents.
    const paths = new Set(this.index.sourcePaths());
    const searched = found ?? await vscode.workspace.findFiles(new vscode.RelativePattern(this.rootUri, '**/*.php'), IGNORED_GLOB);
    for (const uri of [...searched, ...vscode.workspace.textDocuments.filter((document) => !document.isClosed).map((document) => document.uri)]) {
      const path = this.pathOf(uri);
      if (path !== undefined) { paths.add(path); }
    }
    await readInBatches([...paths], (path) => this.load(path, known), () => this.disposed);
  }

  protected pathOf(uri: vscode.Uri): string | undefined {
    const path = this.inRoot(uri);
    return path?.endsWith('.php') && !inIgnoredDirectory(path) ? path : undefined;
  }

  protected set(path: string, source: string): void {
    this.index.update(path, source);
    this.changed.fire();
  }

  protected remove(path: string): void {
    this.index.remove(path);
    this.changed.fire();
  }

  override dispose(): void {
    super.dispose();
    this.changed.dispose();
  }
}
