import { resolveRelativeImport } from '@wicker/core';
import * as vscode from 'vscode';

import { enginePathOf } from './paths.js';
import type { SessionManager } from './session.js';

/** The extensions a script import can reach through AssetMapper. */
const EXTENSIONS = ['.js', '.ts'] as const;

/**
 * Offers the extension a relative import was written without.
 *
 * A bundler adds it; AssetMapper does not, and with strict imports Symfony
 * refuses to render the page. The diagnostic already says so. When exactly
 * one file sits at the path with a known extension, the fix is a certainty,
 * and when two do, both are offered and the reader picks.
 */
export class ImportExtensionActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly sessions: SessionManager) {}

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext): vscode.CodeAction[] {
    const session = this.sessions.sessionFor(document);
    const projectPath = session?.relativePathOf(enginePathOf(document.uri));
    if (!session || projectPath === undefined) { return []; }

    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== 'wicker' || diagnostic.code !== 'unmapped-import' || !diagnostic.range.intersection(range)) { continue; }
      const specifier = document.getText(diagnostic.range);
      // An extension that resolves to nothing is a different problem: the
      // file is missing, and no spelling of the import brings it back.
      if (/\.[a-z0-9]+$/i.test(specifier)) { continue; }
      const relative = resolveRelativeImport(projectPath, specifier);
      if (relative === undefined) { continue; }

      for (const extension of EXTENSIONS) {
        if (session.assets.map.forProjectPath(`${relative}${extension}`) === undefined) { continue; }
        const action = new vscode.CodeAction(`Add ${extension} to the import`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, `${specifier}${extension}`);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        actions.push(action);
      }
    }
    return actions;
  }
}
