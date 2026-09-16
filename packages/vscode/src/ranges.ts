import * as vscode from 'vscode';

import type { OffsetRange } from '@wicker/core';

/** The editor's range for the engine's offsets into a document. */
export function rangeOf(document: vscode.TextDocument, range: OffsetRange): vscode.Range {
  return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
}
