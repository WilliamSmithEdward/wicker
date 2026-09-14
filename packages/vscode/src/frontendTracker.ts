import * as vscode from 'vscode';
import { FrontendIndex, joinProjectPath, toProjectPath } from '@wicker/core';
import type { VsCodeFileSystem } from './fileSystem.js';
import { enginePathOf } from './paths.js';

const EXCLUDED = new Set(['vendor', 'var', 'node_modules', '.git']);
/*
 * The file kinds this tracker reads. Named once: the glob and the path guard
 * are both derived from it, and when they were written separately a change to
 * one silently dropped every file the other still admitted.
 *
 * CSS is included because a stylesheet's own @import chain is how most of a
 * page's styles are reached, and none of those names appear in a template.
 */
const EXTENSIONS = ['php', 'twig', 'js', 'ts', 'map', 'css'] as const;
const PATTERN = `**/*.{${EXTENSIONS.join(',')}}`;
const TRACKED = new RegExp(String.raw`\.(?:${EXTENSIONS.join('|')})$`);

/** Independent of console discovery: dirty buffers immediately update links and
 * response fields without running PHP on every keystroke. */
export class FrontendTracker implements vscode.Disposable {
  readonly index = new FrontendIndex();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private readonly pending = new Map<string, object>();
  private readonly rootUri: vscode.Uri;
  private disposed = false;
  constructor(private readonly root: string, private readonly fs: VsCodeFileSystem) {
    this.rootUri = fs.toUri(root);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.rootUri, PATTERN));
    const reload = (uri: vscode.Uri): void => { void this.load(uri); };
    this.subscriptions = [watcher, watcher.onDidCreate(reload), watcher.onDidChange(reload),
      watcher.onDidDelete((uri) => { const path = this.path(uri); if (path) { this.pending.delete(path); this.index.remove(path); this.changed.fire(); } }),
      vscode.workspace.onDidOpenTextDocument((doc) => this.update(doc)),
      vscode.workspace.onDidChangeTextDocument((event) => this.update(event.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => reload(doc.uri))];
  }
  async refresh(): Promise<void> {
    const uris = new Map(this.index.sourcePaths().map((path) => { const uri = this.fs.toUri(joinProjectPath(this.root, path)); return [uri.toString(), uri]; }));
    for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(this.rootUri, PATTERN),
      '{**/vendor/**,**/var/**,**/node_modules/**,**/.git/**}', 20000)) { uris.set(uri.toString(), uri); }
    for (const doc of vscode.workspace.textDocuments) { if (this.path(doc.uri) && !doc.isClosed) { uris.set(doc.uri.toString(), doc.uri); } }
    const files = [...uris.values()];
    for (let i = 0; i < files.length && !this.disposed; i += 32) { await Promise.all(files.slice(i, i + 32).map((uri) => this.load(uri))); }
  }
  private path(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== this.rootUri.scheme || uri.authority !== this.rootUri.authority) { return undefined; }
    const path = toProjectPath(this.root, enginePathOf(uri));
    return path && TRACKED.test(path) && !path.split('/').some((part) => EXCLUDED.has(part)) ? path : undefined;
  }
  private update(document: vscode.TextDocument): void {
    const path = this.path(document.uri);
    if (!path || document.isClosed || this.disposed) { return; }
    this.pending.delete(path);
    this.set(path, document.getText());
  }
  private set(path: string, source: string | undefined): void {
    if (source === undefined || source.length > 1_000_000) { this.index.remove(path); }
    else { this.index.update(path, source); }
    this.changed.fire();
  }
  private async load(uri: vscode.Uri): Promise<void> {
    const path = this.path(uri);
    if (!path || this.disposed) { return; }
    const request = {};
    this.pending.set(path, request);
    const disk = await this.fs.readFile(joinProjectPath(this.root, path));
    if (this.disposed || this.pending.get(path) !== request) { return; }
    this.pending.delete(path);
    const open = vscode.workspace.textDocuments.find((doc) => !doc.isClosed && doc.uri.toString() === uri.toString());
    this.set(path, disk === undefined ? undefined : open?.getText() ?? disk);
  }
  dispose(): void { this.disposed = true; this.pending.clear(); this.subscriptions.forEach((entry) => { entry.dispose(); }); this.changed.dispose(); }
}
