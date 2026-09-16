import * as vscode from 'vscode';

import { joinProjectPath } from '@wicker/core';

import { Deferred } from './debounce.js';
import type { KnownSources, VsCodeFileSystem } from './fileSystem.js';

/**
 * What the source trackers share.
 *
 * Each keeps an index current from two feeds: the disk, through a watcher and
 * a rebuild, and the open buffers, which win over the disk and arrive at a
 * pause in typing rather than at each key. A disk read that started before an
 * edit, or before a later read of the same file, must not land on top of it,
 * so every read carries a request token and lands only while it is still the
 * latest. Which files count and what is indexed is each tracker's own.
 */
export abstract class SourceTracker implements vscode.Disposable {
  protected readonly rootUri: vscode.Uri;
  protected disposed = false;
  private readonly subscriptions: vscode.Disposable[];
  private readonly pending = new Map<string, object>();
  /** Buffer edits, applied when typing pauses or a reader asks. */
  private readonly deferred = new Deferred<vscode.TextDocument>(300);

  protected constructor(protected readonly root: string, protected readonly fileSystem: VsCodeFileSystem, pattern: string) {
    this.rootUri = fileSystem.toUri(root);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.rootUri, pattern));
    const reload = (uri: vscode.Uri): void => {
      const path = this.pathOf(uri);
      if (path !== undefined && this.watches(path)) { void this.load(path); }
    };
    this.subscriptions = [watcher, watcher.onDidCreate(reload), watcher.onDidChange(reload),
      watcher.onDidDelete((uri) => {
        const path = this.pathOf(uri);
        if (path !== undefined) { this.drop(path); }
      }),
      vscode.workspace.onDidOpenTextDocument((document) => this.update(document)),
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.deferred.schedule(event.document.uri.toString(), event.document, (document) => this.update(document))),
      vscode.workspace.onDidCloseTextDocument((document) => reload(document.uri)),
    ];
  }

  /** The project path of a file this tracker reads, or nothing for any other file. */
  protected abstract pathOf(uri: vscode.Uri): string | undefined;
  /** Whether a change on disk is read; a tracker fed a list of files says no to the rest. */
  protected watches(_path: string): boolean { return true; }
  protected abstract set(path: string, source: string): void;
  protected abstract remove(path: string): void;

  /** An open buffer's text, ahead of whatever the disk holds. */
  update(document: vscode.TextDocument): void {
    const path = this.pathOf(document.uri);
    if (path === undefined || document.isClosed || this.disposed) { return; }
    // Invalidate any disk read that started before this edit.
    this.pending.delete(path);
    this.set(path, document.getText());
  }

  /** Applies every buffer edit still waiting, so a reader sees current text. */
  flush(): void { this.deferred.flush(); }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.deferred.dispose();
    for (const subscription of this.subscriptions) { subscription.dispose(); }
  }

  /** Forgets a file, and any read of it still in flight. */
  protected drop(path: string): void {
    this.pending.delete(path);
    this.remove(path);
  }

  /** The file from the disk, unless a buffer holds it or a rebuild has read it already. */
  protected async load(path: string, known?: KnownSources): Promise<void> {
    if (this.disposed) { return; }
    const shared = known?.(path);
    if (shared !== undefined) {
      // Already read this rebuild, with the same precedence an open buffer
      // would get, so reading it again returns the same text.
      this.pending.delete(path);
      this.set(path, shared);
      return;
    }
    const request = {};
    this.pending.set(path, request);
    const absolute = joinProjectPath(this.root, path);
    const disk = await this.fileSystem.readFile(absolute);
    if (this.disposed || this.pending.get(path) !== request) { return; }
    this.pending.delete(path);
    const uri = this.fileSystem.toUri(absolute);
    const open = vscode.workspace.textDocuments.find((document) => !document.isClosed && document.uri.toString() === uri.toString());
    // VS Code can retain an open document after its file is deleted. It must
    // not resurrect a removed source during a disk refresh.
    if (disk === undefined) { this.remove(path); } else { this.set(path, open?.getText() ?? disk); }
  }
}
