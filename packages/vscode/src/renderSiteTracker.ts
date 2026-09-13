import * as vscode from 'vscode';

import { joinProjectPath, RenderSiteIndex, toProjectPath } from '@wicker/core';

import type { VsCodeFileSystem } from './fileSystem.js';
import { enginePathOf } from './paths.js';

const EXCLUDED_DIRECTORIES = new Set(['vendor', 'var', 'node_modules', '.git']);
const EXCLUDE_GLOB = `{${[...EXCLUDED_DIRECTORIES].map((name) => `**/${name}/**`).join(',')}}`;

/** Maintains disk records with open PHP buffers taking precedence, even before saving. */
export class RenderSiteTracker implements vscode.Disposable {
  readonly index = new RenderSiteIndex();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private readonly pending = new Map<string, object>();
  private readonly rootUri: vscode.Uri;
  private disposed = false;

  constructor(
    private readonly root: string,
    private readonly fileSystem: VsCodeFileSystem,
  ) {
    this.rootUri = fileSystem.toUri(root);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.rootUri, '**/*.php'),
    );
    const reload = (uri: vscode.Uri): void => { void this.load(uri); };
    this.subscriptions = [
      watcher,
      watcher.onDidCreate(reload),
      watcher.onDidChange(reload),
      watcher.onDidDelete((uri) => {
        const path = this.sourcePath(uri);
        if (path !== undefined) {
          this.pending.delete(path);
          this.index.remove(path);
          this.changed.fire();
        }
      }),
      vscode.workspace.onDidOpenTextDocument((document) => this.updateDocument(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.updateDocument(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => reload(document.uri)),
    ];
  }

  async refresh(): Promise<void> {
    // Include old paths so a rebuild also removes deleted sources, and open
    // buffers so an unsaved file is never replaced by its older disk contents.
    const uris = new Map(this.index.sourcePaths().map((path) => {
      const uri = this.fileSystem.toUri(joinProjectPath(this.root, path));
      return [uri.toString(), uri];
    }));
    for (const uri of await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.rootUri, '**/*.php'),
      EXCLUDE_GLOB,
    )) {
      uris.set(uri.toString(), uri);
    }
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isClosed && this.sourcePath(document.uri) !== undefined) {
        uris.set(document.uri.toString(), document.uri);
      }
    }
    const files = [...uris.values()];
    // Bound concurrent reads on remote filesystems.
    for (let start = 0; start < files.length && !this.disposed; start += 32) {
      await Promise.all(files.slice(start, start + 32).map((uri) => this.load(uri)));
    }
  }

  private sourcePath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== this.rootUri.scheme || uri.authority !== this.rootUri.authority) {
      return undefined;
    }
    const path = toProjectPath(this.root, enginePathOf(uri));
    return path?.endsWith('.php') &&
      !path.split('/').some((segment) => EXCLUDED_DIRECTORIES.has(segment))
      ? path : undefined;
  }

  private updateDocument(document: vscode.TextDocument): void {
    const path = this.sourcePath(document.uri);
    if (path === undefined || document.isClosed || this.disposed) {
      return;
    }
    // Invalidate any disk read that started before this edit.
    this.pending.delete(path);
    this.index.update(path, document.getText());
    this.changed.fire();
  }

  private async load(uri: vscode.Uri): Promise<void> {
    const path = this.sourcePath(uri);
    if (path === undefined || this.disposed) {
      return;
    }
    const request = {};
    this.pending.set(path, request);
    const disk = await this.fileSystem.readFile(joinProjectPath(this.root, path));
    if (this.disposed || this.pending.get(path) !== request) {
      return;
    }
    this.pending.delete(path);
    const open = vscode.workspace.textDocuments.find((document) =>
      !document.isClosed && document.uri.toString() === uri.toString(),
    );
    // VS Code can retain an open document after its file is deleted. It must
    // not resurrect a removed render site during a disk refresh.
    const source = disk === undefined ? undefined : open?.getText() ?? disk;
    if (source === undefined) {
      this.index.remove(path);
    } else {
      this.index.update(path, source);
    }
    this.changed.fire();
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.changed.dispose();
  }
}
