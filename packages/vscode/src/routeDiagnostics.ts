import * as vscode from 'vscode';

import { scanOf } from './frontendProject.js';
import { enginePathOf } from './paths.js';
import { rangeOf } from './ranges.js';
import type { ProjectSession, SessionManager } from './session.js';
import { severityFromSettings } from './severity.js';

/**
 * Reports a `path()` or `url()` call the router would refuse.
 *
 * A route that is not registered throws when the page renders, and so does a
 * call that leaves out a placeholder with no default. A key the route does
 * not declare is not a mistake: Symfony appends it as a query string. Only a
 * literal hash is read, since a variable could hold anything. Suspended while
 * the route list is being rebuilt, because a route just saved in PHP is not
 * in the console's last answer until it has been asked again.
 */
export function routeDiagnostics(sessions: SessionManager, session: ProjectSession, document: vscode.TextDocument): vscode.Diagnostic[] {
  const severity = severityFromSettings('missingRouteParameter', 'warning');
  const path = session.relativePathOf(enginePathOf(document.uri));
  if (severity === undefined || path === undefined || !path.endsWith('.twig')) { return []; }
  const routes = session.frontend.routes;
  if (routes.length === 0 || !session.discoveryCurrent) { return []; }

  const result: vscode.Diagnostic[] = [];
  for (const call of scanOf(session, path, document.getText(), true).routeCalls) {
    const route = routes.find((entry) => entry.name === call.name || entry.canonical === call.name);
    const keys = call.keys;
    let problem: { message: string; code: string } | undefined;
    if (route === undefined) {
      problem = { message: `Route "${call.name}" is not registered, so the page cannot render.`, code: 'unknown-route' };
    } else if (keys !== undefined) {
      const missing = route.parameters.filter((parameter) => parameter.required && !keys.includes(parameter.name));
      if (missing.length > 0) {
        problem = { code: 'missing-route-parameter',
          message: `Route "${call.name}" needs ${missing.map((parameter) => `{${parameter.name}}`).join(' and ')}, which this call does not pass.` };
      }
    }
    if (problem === undefined) { continue; }
    const diagnostic = new vscode.Diagnostic(rangeOf(document, call.nameRange), problem.message, severity);
    diagnostic.source = 'wicker';
    diagnostic.code = problem.code;
    result.push(diagnostic);
  }
  return sessions.sessionFor(document) === session ? result : [];
}
