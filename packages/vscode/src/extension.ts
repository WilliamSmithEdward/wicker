import * as vscode from 'vscode';

import { parseTemplateName, type IndexedTemplate } from '@wicker/core';

import {
  clearCache,
  describeKind,
  forgetDocument,
  isSupported,
  templateReferenceAt,
  templateReferencesIn,
  type DocumentTemplateReference,
} from './references.js';
import { SessionManager, type ProjectSession } from './session.js';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'php', scheme: 'file' },
  { language: 'twig', scheme: 'file' },
  { pattern: '**/*.twig', scheme: 'file' },
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessions = new SessionManager();
  context.subscriptions.push(sessions);
  await sessions.initialize();

  const diagnostics = vscode.languages.createDiagnosticCollection('wicker');
  context.subscriptions.push(diagnostics);

  const resolve = (
    document: vscode.TextDocument,
    reference: DocumentTemplateReference,
  ): { session: ProjectSession; template: IndexedTemplate } | undefined => {
    const session = sessions.sessionFor(document);
    if (session === undefined) {
      return undefined;
    }
    const template = session.lookup(reference.templateName);
    return template === undefined ? undefined : { session, template };
  };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(SELECTOR, {
      provideDefinition(document, position) {
        const reference = templateReferenceAt(document, position);
        if (reference === undefined) {
          return undefined;
        }
        const resolved = resolve(document, reference);
        if (resolved === undefined) {
          return undefined;
        }
        return [
          {
            originSelectionRange: reference.nameRange,
            targetUri: resolved.session.uriFor(resolved.template),
            targetRange: new vscode.Range(0, 0, 0, 0),
            targetSelectionRange: new vscode.Range(0, 0, 0, 0),
          } satisfies vscode.LocationLink,
        ];
      },
    }),

    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover(document, position) {
        const reference = templateReferenceAt(document, position);
        if (reference === undefined) {
          return undefined;
        }
        const session = sessions.sessionFor(document);
        if (session === undefined) {
          return undefined;
        }
        return new vscode.Hover(hoverContent(session, reference), reference.nameRange);
      },
    }),

    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      {
        provideCompletionItems(document, position) {
          const reference = templateReferenceAt(document, position);
          if (reference === undefined) {
            return undefined;
          }
          const session = sessions.sessionFor(document);
          if (session === undefined) {
            return undefined;
          }

          return session.index.allNames().map((name) => {
            const template = session.lookup(name);
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.File);
            item.range = reference.nameRange;
            if (template !== undefined) {
              item.detail = template.projectPath;
            }
            // Sort main-namespace templates above namespaced ones, which are
            // usually vendor templates the user is not reaching for.
            item.sortText = `${name.startsWith('@') ? '1' : '0'}${name}`;
            return item;
          });
        },
      },
      "'",
      '"',
      '/',
      '@',
    ),

    vscode.commands.registerCommand('wicker.reindex', async () => {
      clearCache();
      await sessions.refreshAll();
      refreshAllDiagnostics();
      void vscode.window.showInformationMessage('Wicker: template index rebuilt.');
    }),

    vscode.commands.registerCommand('wicker.showProjectInfo', () => {
      const all = sessions.all();
      if (all.length === 0) {
        void vscode.window.showWarningMessage('Wicker: no Symfony project detected.');
        return;
      }
      const lines = all.map((session) => {
        const namespaces = session.index
          .allNames()
          .filter((name) => name.startsWith('@'))
          .map((name) => name.slice(1, name.indexOf('/')));
        return [
          session.project.root,
          `  templates: ${session.index.size}`,
          `  namespaces: ${[...new Set(namespaces)].join(', ') || '(main only)'}`,
          `  detected by: ${session.project.evidence.join(', ')}`,
        ].join('\n');
      });
      void vscode.window.showInformationMessage('Wicker', { modal: true, detail: lines.join('\n\n') });
    }),
  );

  // Diagnostics.
  const refreshDiagnostics = (document: vscode.TextDocument): void => {
    if (!isSupported(document) || document.uri.scheme !== 'file') {
      return;
    }
    const session = sessions.sessionFor(document);
    if (session === undefined) {
      diagnostics.delete(document.uri);
      return;
    }
    diagnostics.set(document.uri, buildDiagnostics(session, document));
  };

  const refreshAllDiagnostics = (): void => {
    for (const document of vscode.workspace.textDocuments) {
      refreshDiagnostics(document);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
    vscode.workspace.onDidChangeTextDocument((event) => refreshDiagnostics(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      forgetDocument(document.uri);
      diagnostics.delete(document.uri);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      for (const folder of event.added) {
        await sessions.addFolder(folder);
      }
      for (const folder of event.removed) {
        sessions.removeFolder(folder);
      }
      refreshAllDiagnostics();
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('wicker')) {
        await sessions.refreshAll();
        refreshAllDiagnostics();
      }
    }),
    // The index changing can turn a missing template into a found one.
    sessions.onDidChange(() => refreshAllDiagnostics()),
  );

  refreshAllDiagnostics();
}

export function deactivate(): void {
  clearCache();
}

function hoverContent(
  session: ProjectSession,
  reference: DocumentTemplateReference,
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;

  const template = session.lookup(reference.templateName);
  if (template === undefined) {
    markdown.appendMarkdown(`**Template not found**\n\n`);
    markdown.appendMarkdown(`\`${reference.templateName}\` from a ${describeKind(reference)}.\n\n`);

    const parsed = parseTemplateName(reference.templateName);
    if (!parsed.ok) {
      markdown.appendMarkdown(`${parsed.problem.message}\n`);
    } else if (parsed.value.namespace !== null) {
      markdown.appendMarkdown(
        `The \`@${parsed.value.namespace}\` namespace is not registered in this project.\n`,
      );
    }
    return markdown;
  }

  markdown.appendMarkdown(`**${template.name}**\n\n`);
  markdown.appendMarkdown(`\`${template.projectPath}\`\n\n`);
  markdown.appendMarkdown(`Referenced by a ${describeKind(reference)}.`);

  if (reference.contextKeys.length > 0) {
    const keys = reference.contextKeys.map((key) => `\`${key}\``).join(', ');
    markdown.appendMarkdown(`\n\nPasses ${keys}`);
    if (reference.contextIsDynamic) {
      markdown.appendMarkdown(', and more that are not statically known');
    }
    markdown.appendMarkdown('.');
  } else if (reference.contextIsDynamic) {
    markdown.appendMarkdown('\n\nPasses variables that are not statically known.');
  }

  const shadowed = session.index.candidatesFor(template.name).filter((entry) => entry.shadowed);
  if (shadowed.length > 0) {
    markdown.appendMarkdown(
      `\n\nOverrides ${shadowed.map((entry) => `\`${entry.projectPath}\``).join(', ')}.`,
    );
  }

  return markdown;
}

function buildDiagnostics(
  session: ProjectSession,
  document: vscode.TextDocument,
): vscode.Diagnostic[] {
  const severity = severityFromSettings();
  if (severity === undefined) {
    return [];
  }

  const result: vscode.Diagnostic[] = [];
  for (const reference of templateReferencesIn(document)) {
    // One of several candidates Twig tries in turn; a missing file is normal.
    if (reference.isCandidateList) {
      continue;
    }
    if (session.lookup(reference.templateName) !== undefined) {
      continue;
    }

    const parsed = parseTemplateName(reference.templateName);
    const message = !parsed.ok
      ? parsed.problem.message
      : parsed.value.namespace !== null && !session.index.allNames().some((name) => name.startsWith(`@${parsed.value.namespace}/`))
        ? `Twig namespace "@${parsed.value.namespace}" is not registered in this project.`
        : `Template "${reference.templateName}" was not found.`;

    const diagnostic = new vscode.Diagnostic(reference.nameRange, message, severity);
    diagnostic.source = 'wicker';
    diagnostic.code = parsed.ok ? 'template-not-found' : parsed.problem.kind;
    result.push(diagnostic);
  }
  return result;
}

function severityFromSettings(): vscode.DiagnosticSeverity | undefined {
  const setting = vscode.workspace
    .getConfiguration('wicker')
    .get<string>('diagnostics.missingTemplate', 'error');

  switch (setting) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'information':
      return vscode.DiagnosticSeverity.Information;
    default:
      return undefined;
  }
}
