import * as vscode from 'vscode';

import type { OffsetRange } from '@wicker/core';

/** The editor's range for the engine's offsets into a document. */
export function rangeOf(document: vscode.TextDocument, range: OffsetRange): vscode.Range {
  return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
}

/** The same, in a file the caller has only the text of, such as one read from the index. */
export function rangeInSource(source: string, range: OffsetRange): vscode.Range {
  return new vscode.Range(positionInSource(source, range.start), positionInSource(source, range.end));
}

function positionInSource(source: string, offset: number): vscode.Position {
  const before = source.slice(0, offset);
  const line = (before.match(/\n/g) ?? []).length;
  return new vscode.Position(line, offset - (before.lastIndexOf('\n') + 1));
}
