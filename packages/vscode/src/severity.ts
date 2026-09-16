import * as vscode from 'vscode';

/** The diagnostics a setting can turn down or off. */
export type SeveritySetting = 'missingTemplate' | 'missingImport' | 'unknownCallable' | 'missingRouteParameter';

/**
 * How a diagnostic setting maps to a severity, or to none at all.
 *
 * Each of the diagnostics read its own setting through its own copy of
 * this switch. The callable one reads at the document's scope, because it is
 * the one a folder in a multi-root workspace is likely to want quiet on its
 * own; passing the scope keeps that.
 */
export function severityFromSettings(setting: SeveritySetting, fallback: string,
  scope?: vscode.Uri): vscode.DiagnosticSeverity | undefined {
  switch (vscode.workspace.getConfiguration('wicker', scope).get<string>(`diagnostics.${setting}`, fallback)) {
    case 'error': return vscode.DiagnosticSeverity.Error;
    case 'warning': return vscode.DiagnosticSeverity.Warning;
    case 'information': return vscode.DiagnosticSeverity.Information;
    default: return undefined;
  }
}
