import * as vscode from 'vscode';
import { FrontendIndex } from '@wicker/core';
import { readInBatches, type VsCodeFileSystem } from './fileSystem.js';
import { inIgnoredDirectory, IGNORED_GLOB } from './paths.js';
import { SourceTracker } from './sourceTracker.js';

/*
 * The file kinds this tracker reads. Named once: the glob and the path guard
 * are both derived from it, and when they were written separately a change to
 * one silently dropped every file the other still admitted.
 *
 * CSS is included because a stylesheet's own @import chain is how most of a
 * page's styles are reached, and none of those names appear in a template.
 *
 * Source maps are deliberately absent. They are the largest files a project
 * has, nothing is ever parsed out of them, and they are consulted only when a
 * script row turns out to be compiled output, so they are read then instead of
 * every one of them being read to open a project.
 */
const EXTENSIONS = ['php', 'twig', 'js', 'ts', 'css'] as const;
const PATTERN = `**/*.{${EXTENSIONS.join(',')}}`;
const TRACKED = new RegExp(String.raw`\.(?:${EXTENSIONS.join('|')})$`);

/** Independent of console discovery: dirty buffers immediately update links and
 * response fields without running PHP on every keystroke. */
export class FrontendTracker extends SourceTracker {
  readonly index = new FrontendIndex();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(root: string, fs: VsCodeFileSystem) { super(root, fs, PATTERN); }

  /**
   * Reads every tracked file, and returns what the search found so the render
   * site tracker can read its PHP without searching the workspace again.
   */
  async refresh(): Promise<readonly vscode.Uri[]> {
    // Old paths too, so a rebuild also removes deleted sources, and open
    // buffers, so an unsaved file is never replaced by its older disk text.
    const paths = new Set(this.index.sourcePaths());
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(this.rootUri, PATTERN), IGNORED_GLOB, 20000);
    for (const uri of [...found, ...vscode.workspace.textDocuments.filter((doc) => !doc.isClosed).map((doc) => doc.uri)]) {
      const path = this.pathOf(uri);
      if (path !== undefined) { paths.add(path); }
    }
    await readInBatches([...paths], (path) => this.load(path), () => this.disposed);
    return found;
  }

  protected pathOf(uri: vscode.Uri): string | undefined {
    const path = this.inRoot(uri);
    return path && TRACKED.test(path) && !inIgnoredDirectory(path) ? path : undefined;
  }

  protected set(path: string, source: string): void {
    // A file that size is generated output, and parsing it would stall the host.
    if (source.length > 1_000_000) { this.index.remove(path); } else { this.index.update(path, source); }
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
