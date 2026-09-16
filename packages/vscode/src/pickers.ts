import * as vscode from 'vscode';

import type { OffsetRange } from '@wicker/core';

import { compareRoutePaths, routeAction } from './frontendProject.js';
import { basename } from './paths.js';
import { rangeOf } from './ranges.js';
import type { ProjectSession, SessionManager } from './session.js';

/** Where choosing a row goes: a file, and the text in it to select when there is one. */
interface Destination {
  readonly session: ProjectSession;
  readonly projectPath: string;
  readonly range?: OffsetRange;
}

export interface RoutePick extends vscode.QuickPickItem, Destination { readonly range: OffsetRange }
export interface TemplatePick extends vscode.QuickPickItem, Destination {}

/**
 * Every route whose action is in the workspace, sorted by path.
 *
 * The router's debug table is the one place a project's URLs are listed
 * together, and this is that table made clickable. The framework's own
 * routes, the profiler and the toolbar among them, have no action here to
 * open, so they are left out rather than listed as rows that go nowhere.
 */
export function routePicks(sessions: SessionManager): RoutePick[] {
  const projects = sessions.all();
  return projects.flatMap((session) => [...session.frontend.routes].sort(compareRoutePaths).flatMap((route) => {
    const found = routeAction(sessions, session, route);
    if (found === undefined || !sessions.owns(session, found.projectPath)) { return []; }
    return [{
      label: `${route.methods} ${route.path}`, description: route.name,
      detail: `${found.action.className.split('\\').at(-1)}::${found.action.methodName}()${whose(projects, session)}`,
      session, projectPath: found.projectPath, range: found.action.range,
    }];
  }));
}

/**
 * Every template by its logical name, the application's own first.
 *
 * Quick Open finds files by path, and a template's path is not its name: an
 * override lives under templates/bundles while it answers to @Bundle, and a
 * namespace maps to a directory only the loader configuration knows.
 */
export function templatePicks(sessions: SessionManager): TemplatePick[] {
  const projects = sessions.all();
  return projects.flatMap((session) => [...session.index.allNames()]
    .sort((a, b) => Number(a.startsWith('@')) - Number(b.startsWith('@')) || a.localeCompare(b))
    .flatMap((name) => {
      const template = session.lookup(name);
      return template === undefined ? [] : [{
        label: name, description: `${template.projectPath}${whose(projects, session)}`,
        session, projectPath: template.projectPath,
      }];
    }));
}

/** Asks for a route and opens its action, with the method name selected. */
export async function goToRoute(sessions: SessionManager): Promise<void> {
  const picks = routePicks(sessions);
  if (picks.length === 0) {
    const unavailable = sessions.all().map((session) => session.frontend.routesStatus)
      .find((status) => status.startsWith('unavailable'));
    void vscode.window.showInformationMessage(unavailable === undefined
      ? 'Wicker found no route with an action in this workspace.'
      : `Wicker has no routes to list. Routes: ${unavailable}.`);
    return;
  }
  const pick = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Route path, name or controller', matchOnDescription: true, matchOnDetail: true,
  });
  if (pick !== undefined) { await open(pick); }
}

/** Asks for a template by logical name and opens its file. */
export async function goToTemplate(sessions: SessionManager): Promise<void> {
  const picks = templatePicks(sessions);
  if (picks.length === 0) {
    void vscode.window.showInformationMessage('Wicker has indexed no templates in this workspace.');
    return;
  }
  const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Template name', matchOnDescription: true });
  if (pick !== undefined) { await open(pick); }
}

/** Only a workspace with several projects needs a row to say whose it is. */
function whose(projects: readonly ProjectSession[], session: ProjectSession): string {
  return projects.length > 1 ? ` · ${basename(session.project.root)}` : '';
}

async function open(destination: Destination): Promise<void> {
  const document = await vscode.workspace.openTextDocument(destination.session.uriOf(destination.projectPath));
  const { range } = destination;
  await vscode.window.showTextDocument(document, { preview: true, ...(range === undefined ? {} : { selection: rangeOf(document, range) }) });
}
