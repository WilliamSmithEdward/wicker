import * as vscode from 'vscode';

import { joinProjectPath, TemplateContextIndex, type TwigTemplateIndex } from '@wicker/core';

import type { VsCodeFileSystem } from './fileSystem.js';
import { enginePathOf } from './paths.js';

/** Twig text stays current independently of console discovery and template-name indexing. */
export class TemplateContextTracker implements vscode.Disposable {
  readonly index = new TemplateContextIndex();
  private readonly subscriptions: vscode.Disposable[];
  private readonly pending = new Map<string, object>();
  private known = new Set<string>();
  private disposed = false;

  constructor(private readonly root: string, private readonly fileSystem: VsCodeFileSystem,
    private readonly relativePath: (absolute: string) => string | undefined) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(fileSystem.toUri(root), '**/*.twig'));
    const load = (uri: vscode.Uri): void => {
      const path = this.pathOf(uri);
      if (path !== undefined && this.known.has(path)) { void this.load(path); }
    };
    this.subscriptions = [watcher, watcher.onDidCreate(load), watcher.onDidChange(load),
      watcher.onDidDelete((uri) => {
        const path = this.pathOf(uri);
        if (path !== undefined) { this.pending.delete(path); this.index.remove(path); }
      }),
      vscode.workspace.onDidOpenTextDocument((document) => this.update(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.update(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => load(document.uri)),
    ];
  }

  /** Read new loader files; watcher events maintain files already loaded. */
  async refresh(templates: TwigTemplateIndex, force = false): Promise<void> {
    const paths = new Set(templates.allNames().flatMap((name) => templates.candidatesFor(name).map((entry) => entry.projectPath)));
    for (const path of this.known) {
      if (!paths.has(path)) { this.pending.delete(path); this.index.remove(path); }
    }
    const added = [...paths].filter((path) => force || !this.known.has(path));
    this.known = paths;
    for (let at = 0; at < added.length && !this.disposed; at += 16) {
      await Promise.all(added.slice(at, at + 16).map((path) => this.load(path)));
    }
  }

  update(document: vscode.TextDocument): void {
    const path = this.pathOf(document.uri);
    if (path === undefined || document.isClosed || this.disposed) { return; }
    this.pending.delete(path);
    this.index.update(path, document.getText());
  }

  private pathOf(uri: vscode.Uri): string | undefined {
    const rootUri = this.fileSystem.toUri(this.root);
    if (uri.scheme !== rootUri.scheme || uri.authority !== rootUri.authority) { return undefined; }
    const path = this.relativePath(enginePathOf(uri));
    return path?.endsWith('.twig') ? path : undefined;
  }

  private async load(path: string): Promise<void> {
    const request = {};
    this.pending.set(path, request);
    const text = await this.fileSystem.readFile(joinProjectPath(this.root, path));
    if (this.disposed || this.pending.get(path) !== request) { return; }
    this.pending.delete(path);
    if (text === undefined) { this.index.remove(path); return; }
    const uri = this.fileSystem.toUri(joinProjectPath(this.root, path));
    const open = vscode.workspace.textDocuments.find((document) => !document.isClosed && document.uri.toString() === uri.toString());
    this.index.update(path, open?.getText() ?? text);
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    for (const item of this.subscriptions) { item.dispose(); }
  }
}
