import * as vscode from 'vscode';

import { templateReferencesIn } from './references.js';
import type { SessionManager } from './session.js';

/**
 * Turning a missing-template error into something the user can act on.
 *
 * An error message that names a problem without offering a fix leaves the
 * reader to work out the answer: which directory the file belongs in, what a
 * new template should contain, and whether the namespace even maps anywhere.
 * The engine already knows all three, so it offers to do it.
 */
export class CreateTemplateActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  private readonly sessions: SessionManager;

  constructor(sessions: SessionManager) {
    this.sessions = sessions;
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const session = this.sessions.sessionFor(document);
    if (session === undefined) {
      return [];
    }

    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== 'wicker' || diagnostic.code !== 'template-not-found') {
        continue;
      }
      if (!diagnostic.range.intersection(range)) {
        continue;
      }

      const reference = templateReferencesIn(document).find((candidate) =>
        candidate.nameRange.isEqual(diagnostic.range),
      );
      if (reference === undefined) {
        continue;
      }

      const target = session.suggestedPathFor(reference.templateName);
      if (target === undefined) {
        // An unregistered namespace maps to no directory, so there is nowhere
        // correct to put the file. Offering to create one would produce a
        // template Twig could never load.
        continue;
      }

      const action = new vscode.CodeAction(
        `Create ${target.projectPath}`,
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [diagnostic];
      action.isPreferred = true;

      // A WorkspaceEdit rather than a direct write, so the whole thing is a
      // single undoable step and the editor previews it before applying.
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(target.uri, { ignoreIfExists: true });
      edit.insert(target.uri, new vscode.Position(0, 0), scaffoldFor(session, reference.templateName));
      action.edit = edit;

      action.command = {
        command: 'vscode.open',
        title: 'Open the new template',
        arguments: [target.uri],
      };

      actions.push(action);
    }
    return actions;
  }
}

/**
 * Starting content for a newly created template.
 *
 * A template that extends the project's layout and fills its body block is
 * almost always what was wanted, and leaves the file immediately usable. When
 * there is no layout to extend, a bare comment is less presumptuous than
 * inventing a structure.
 */
function scaffoldFor(
  session: { layoutTemplateName(): string | undefined },
  templateName: string,
): string {
  const layout = session.layoutTemplateName();
  if (layout === undefined) {
    return `{# ${templateName} #}\n`;
  }
  return `{% extends '${layout}' %}\n\n{% block body %}\n\n{% endblock %}\n`;
}
