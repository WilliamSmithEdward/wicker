import * as vscode from 'vscode';

import { templateReferencesIn } from './references.js';
import type { SessionManager } from './session.js';

/**
 * The token type given to a template name that resolves to a file.
 *
 * Contributed rather than reused from the standard set, so a theme or a user
 * can colour Wicker's conclusions without also recolouring every type name in
 * every language. `package.json` declares it with `type` as its super type, so
 * a theme that has never heard of Wicker still colours it sensibly.
 */
const TEMPLATE_TOKEN_TYPE = 'wickerTemplate';

export const SEMANTIC_TOKENS_LEGEND = new vscode.SemanticTokensLegend([TEMPLATE_TOKEN_TYPE]);

/**
 * Colours template names the extension was able to resolve.
 *
 * A grammar paints every string alike, because at that point a template name
 * and a CSS class are both just quoted text. This runs after the index is
 * built and recolours only the names that actually reach a file, which makes
 * the bridge visible in the code rather than only on hover.
 *
 * Unresolved names are deliberately left in the plain string colour: they
 * already carry a diagnostic, and colouring them here would say Wicker
 * understood something it did not.
 */
export class TemplateSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  private readonly changed = new vscode.EventEmitter<void>();

  /** Fired when the index changes, so resolved names recolour without an edit. */
  readonly onDidChangeSemanticTokens = this.changed.event;

  constructor(private readonly sessions: SessionManager) {}

  /** Recomputes tokens for every open editor. */
  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens | undefined {
    const session = this.sessions.sessionFor(document);
    if (session === undefined) {
      return undefined;
    }

    const builder = new vscode.SemanticTokensBuilder(SEMANTIC_TOKENS_LEGEND);
    for (const range of resolvedNameRanges(document, session)) {
      builder.push(range, TEMPLATE_TOKEN_TYPE);
    }
    return builder.build();
  }
}

/**
 * Ranges of the template names in a document that resolve to a file, in the
 * order the builder requires.
 */
function resolvedNameRanges(
  document: vscode.TextDocument,
  session: { lookup(name: string): unknown },
): vscode.Range[] {
  const ranges: vscode.Range[] = [];

  for (const reference of templateReferencesIn(document)) {
    // One of several names Twig tries in turn. Colouring the whole list would
    // claim each one resolves, when at most one of them is the file used.
    if (reference.isCandidateList) {
      continue;
    }
    if (session.lookup(reference.templateName) === undefined) {
      continue;
    }
    // A semantic token cannot span lines. A template name inside a single
    // quoted string never does, but a malformed one could, and a token the
    // editor rejects would drop every token after it.
    if (reference.nameRange.start.line !== reference.nameRange.end.line) {
      continue;
    }
    ranges.push(reference.nameRange);
  }

  // The builder requires ascending order, and the scanner's order follows the
  // shape of the source rather than the position in it.
  return ranges.sort((a, b) => a.start.compareTo(b.start));
}
