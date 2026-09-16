import * as vscode from 'vscode';

import type { OffsetRange } from '@wicker/core';

import { compareRoutePaths, routeAction } from './frontendProject.js';
import type { ProjectSession, SessionManager } from './session.js';

/** A route as the picker lists it, and where choosing it goes. */
export interface RoutePick extends vscode.QuickPickItem {
  readonly session: ProjectSession;
  readonly projectPath: string;
  readonly range: OffsetRange;
}

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
    // Only a workspace with several projects needs each row to say whose it is.
    const project = projects.length > 1 ? ` · ${session.project.root.split(/[\\/]/).filter(Boolean).at(-1) ?? ''}` : '';
    return [{
      label: `${route.methods} ${route.path}`, description: route.name,
      detail: `${found.action.className.split('\\').at(-1)}::${found.action.methodName}()${project}`,
      session, projectPath: found.projectPath, range: found.action.range,
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
  if (pick === undefined) { return; }
  const document = await vscode.workspace.openTextDocument(pick.session.uriOf(pick.projectPath));
  await vscode.window.showTextDocument(document, { preview: true,
    selection: new vscode.Range(document.positionAt(pick.range.start), document.positionAt(pick.range.end)) });
}
