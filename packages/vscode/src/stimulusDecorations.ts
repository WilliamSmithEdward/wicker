import { stimulusDeclarationRanges, stimulusIdentifier, stimulusSource, type OffsetRange } from '@wicker/core';
import * as vscode from 'vscode';

import { enginePathOf } from './paths.js';
import type { SessionManager } from './session.js';

/**
 * Colours the Stimulus members a controller declares.
 *
 * `static values = { statusUrl: String }` is an ordinary object literal to
 * every other tool in the editor, so `statusUrl` is painted as a plain
 * property key. It is not one: Stimulus turns it into `statusUrlValue`, a
 * typed accessor, a `hasStatusUrlValue` check and a change callback, and the
 * same name appears in Twig as a data attribute. Colouring it marks the names
 * that cross that boundary.
 *
 * Decorations rather than semantic tokens, deliberately. VS Code selects a
 * single semantic tokens provider per document, and the built-in TypeScript
 * extension already supplies one for JavaScript. Registering another would
 * either take that slot, losing every built-in JS colour, or lose it and never
 * run, with a score tie broken by activation order. Decorations layer over the
 * existing colouring instead of competing for it.
 */
export class StimulusMemberDecorator implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('wicker.stimulusMember'),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  constructor(private readonly sessions: SessionManager) {}

  /** Repaints every visible editor. Cheap enough: only controllers are parsed. */
  refresh(editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void {
    for (const editor of editors) {
      editor.setDecorations(this.decoration, this.rangesFor(editor.document));
    }
  }

  dispose(): void {
    this.decoration.dispose();
  }

  /**
   * The declaration ranges in a document, or nothing when it is not a Stimulus
   * controller inside a project Wicker owns.
   *
   * Going through `sessionFor` means `wicker.enable` turns this off with
   * everything else rather than leaving stray colour behind.
   */
  private rangesFor(document: vscode.TextDocument): vscode.Range[] {
    if (document.uri.scheme !== 'file' || !/\.[jt]s$/.test(document.uri.path)) {
      return [];
    }
    const session = this.sessions.sessionFor(document);
    const projectPath = session?.relativePathOf(enginePathOf(document.uri));
    if (projectPath === undefined || stimulusIdentifier(projectPath) === undefined) {
      return [];
    }

    return stimulusDeclarationRanges(stimulusSource(document.getText()))
      .map((range) => toRange(document, range));
  }
}

function toRange(document: vscode.TextDocument, range: OffsetRange): vscode.Range {
  return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
}
