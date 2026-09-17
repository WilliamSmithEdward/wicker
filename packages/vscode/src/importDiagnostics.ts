import { importSpecifiers, resolveRelativeImport } from '@wicker/core';
import { severityFromSettings } from './severity.js';
import * as vscode from 'vscode';

import { IMPORTMAP_READER } from './assetDiscovery.js';
import { importMapReaderSource } from './frontendProject.js';
import { enginePathOf } from './paths.js';
import type { ProjectSession, SessionManager } from './session.js';
import { rangeOf } from './ranges.js';

/**
 * Reports an import the browser will not be able to resolve.
 *
 * Nothing bundles these, so a specifier is checked the way the browser checks
 * it. The two kinds fail in different places, which the messages say:
 *
 * A relative specifier is resolved by AssetMapper before the page is served.
 * With `missing_import_mode: strict` a target outside the asset map is a 500,
 * and so is one written without its file extension. Verified against a real
 * application rather than assumed.
 *
 * A bare specifier is resolved by the browser against the importmap, and
 * Symfony renders the page happily either way. Symfony emits no prefix
 * mappings, so a subpath of a declared package is no more resolvable than an
 * invented name; both fail at runtime with nothing in the server log.
 *
 * Both checks are suspended when the evidence for them is missing, since a
 * warning on every import is worse than none. For a bare specifier that
 * includes a project with a say in what the import map holds: `importmap.php`
 * is the whole map only while Symfony's own reader reads it, and a project
 * that replaces the reader can generate entries it never writes to the file.
 */
export function missingImportDiagnostics(
  sessions: SessionManager,
  session: ProjectSession,
  document: vscode.TextDocument,
): vscode.Diagnostic[] {
  const severity = severityFromSettings('missingImport', 'warning');
  const projectPath = session.relativePathOf(enginePathOf(document.uri));
  if (severity === undefined || projectPath === undefined) {
    return [];
  }

  const { map, importMap, importMapFound, settings } = session.assets;
  // Without the configured roots every relative target looks absent, and
  // without importmap.php every bare specifier does.
  const canCheckRelative = settings !== undefined;
  // A file that yields no entries is one this could not read, not a project
  // that declares nothing: an application with an importmap.php has entries in
  // it. Reporting from an empty read marks every bare specifier in the project
  // as unresolvable, which is exactly the shape of a wrong answer given
  // confidently.
  const canCheckBare = importMapFound && importMap.length > 0 && importMapReaderSource(sessions, session) === undefined;

  const source = document.getText();
  const result: vscode.Diagnostic[] = [];

  for (const found of importSpecifiers(source)) {
    const relative = resolveRelativeImport(projectPath, found.specifier);
    let message: string | undefined;

    if (relative !== undefined) {
      if (canCheckRelative && map.forProjectPath(relative) === undefined) {
        message = /\.[a-z0-9]+$/i.test(found.specifier)
          ? `"${found.specifier}" is not a mapped asset. Symfony refuses to render a page whose relative import resolves to nothing.`
          : `"${found.specifier}" has no file extension. AssetMapper does not add one, and Symfony refuses to render the page.`;
      }
    } else if (canCheckBare && !importMap.some((entry) => entry.specifier === found.specifier)) {
      message = `"${found.specifier}" is in no importmap.php entry, so the browser cannot resolve it. The page still renders; the module fails to load.`;
    }

    if (message === undefined) { continue; }
    const diagnostic = new vscode.Diagnostic(
      rangeOf(document, found.range),
      message,
      severity,
    );
    diagnostic.source = 'wicker';
    diagnostic.code = relative !== undefined ? 'unmapped-import' : 'unknown-import-specifier';
    result.push(diagnostic);
  }

  return sessions.sessionFor(document) === session ? result : [];
}

/** What the import map is read from, for the diagnostics report: why a bare import is or is not checked. */
export function describeImportMap(sessions: SessionManager, session: ProjectSession): string {
  const { importMap, importMapFound } = session.assets;
  if (!importMapFound) { return 'no importmap.php'; }
  const entries = `${importMap.length} ${importMap.length === 1 ? 'entry' : 'entries'} in importmap.php`;
  const source = importMapReaderSource(sessions, session);
  return source === undefined ? entries
    : `${entries}; ${source} names ${IMPORTMAP_READER}, so the project may add its own: bare imports are not checked, and a # alias is followed to the asset it names`;
}

