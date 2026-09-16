import * as vscode from 'vscode';
import { counted } from './text.js';

import type { RenderSite } from '@wicker/core';

import type { SessionManager } from './session.js';
import { rangeOf } from './ranges.js';

const OPEN_RENDER_SITE = 'wicker.openRenderSite';

/** One link per PHP render site, above the template's first line. */
export class RenderedByProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly sessions: SessionManager) {
    this.subscriptions = [
      sessions.onDidChange(() => this.refresh()),
      sessions.onDidChangeRenderSites(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('wicker.enable') || event.affectsConfiguration('wicker.codeLens')) {
          this.refresh();
        }
      }),
      vscode.commands.registerCommand(OPEN_RENDER_SITE,
        (template: vscode.Uri, site: RenderSite) => this.openRenderSite(template, site)),
    ];
  }

  private refresh(): void {
    if (this.refreshTimer === undefined) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined;
        this.changed.fire();
      }, 50);
    }
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('wicker').get<boolean>('codeLens.enabled', true)) {
      return [];
    }
    return [...this.renderedByLenses(document), ...this.extendedByLenses(document)];
  }

  /**
   * How many templates extend this one.
   *
   * The same direction as the render sites: what points at this file. What it
   * extends is on its own first line and already navigates, so a lens saying
   * so would repeat the line below it.
   */
  private extendedByLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const count = this.sessions.extendingTemplateCount(document);
    if (count === 0) { return []; }
    return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      title: `Extended by ${counted(count, 'template')}`,
      tooltip: 'Templates that inherit the blocks this one declares. Browse them in the Wicker sidebar.',
      command: 'wicker.revealTemplate',
    })];
  }

  private renderedByLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return this.sessions.renderSitesFor(document).map((site) => {
      const owner = site.className?.split('\\').at(-1) ?? site.projectPath;
      const label = site.methodName === undefined ? owner : `${owner}::${site.methodName}`;
      return new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: `Rendered by ${label}`,
        tooltip: `Open ${site.projectPath} (${site.kind === 'template-attribute' ? '#[Template]' : `${site.kind}()`})`,
        command: OPEN_RENDER_SITE,
        arguments: [document.uri, site],
      });
    });
  }

  private async openRenderSite(templateUri: vscode.Uri, requested: RenderSite): Promise<void> {
    const template = await vscode.workspace.openTextDocument(templateUri);
    const session = this.sessions.sessionFor(template);
    if (session === undefined) {
      return;
    }
    const currentSite = (): RenderSite | undefined =>
      this.sessions.renderSitesFor(template).find((site) =>
        site.projectPath === requested.projectPath &&
        site.templateName === requested.templateName &&
        site.nameRange.start === requested.nameRange.start,
      );
    if (currentSite() === undefined) {
      this.refresh();
      return;
    }
    const uri = session.uriOf(requested.projectPath);
    const source = await vscode.workspace.openTextDocument(uri);
    // Opening the source may have refreshed its offsets. A stale lens must
    // refresh instead of navigating to unrelated text at its former offset.
    const site = currentSite();
    if (site === undefined || this.sessions.sessionFor(template) !== session) {
      this.refresh();
      return;
    }
    await vscode.window.showTextDocument(source, { selection: rangeOf(source, site.nameRange) });
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.changed.dispose();
  }
}
