import * as vscode from 'vscode';

import {
  parseTemplateName,
  type IndexedTemplate,
  type LoaderPathSource,
} from '@wicker/core';

import { CreateTemplateActionProvider } from './codeActions.js';
import {
  articleFor,
  clearCache,
  describeKind,
  forgetDocument,
  isSupported,
  templateReferenceAt,
  templateReferencesIn,
  type DocumentTemplateReference,
} from './references.js';
import { LoaderPathMemory } from './loaderPathMemory.js';
import {
  SEMANTIC_TOKENS_LEGEND,
  TemplateSemanticTokensProvider,
} from './semanticTokens.js';
import { SessionManager, type ProjectSession } from './session.js';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'php', scheme: 'file' },
  { language: 'twig', scheme: 'file' },
  { pattern: '**/*.twig', scheme: 'file' },
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Workspace-scoped, because the remembered namespaces describe this project
  // and mean nothing anywhere else.
  const sessions = new SessionManager(new LoaderPathMemory(context.workspaceState));
  const semanticTokens = new TemplateSemanticTokensProvider(sessions);
  const output = vscode.window.createOutputChannel('Wicker');
  const diagnostics = vscode.languages.createDiagnosticCollection('wicker');

  // Reports what Wicker found without stealing focus. Clicking it opens the
  // detail, so the count is glanceable and the reasoning is one click away
  // rather than pushed at the user in a dialog.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'wicker.showProjectInfo';

  context.subscriptions.push(sessions, output, diagnostics, status);

  const updateStatus = (): void => {
    const all = sessions.all();
    if (all.length === 0) {
      status.hide();
      return;
    }
    const templates = all.reduce((total, session) => total + session.index.fileCount, 0);
    // The weakest source across projects, since the warning has to describe
    // the project that is worst off rather than the average.
    const source = weakestSource(all);

    // The badge answers "is Wicker working", which is the only thing worth a
    // permanent place in the status bar. The count is detail, and detail
    // belongs in the tooltip where there is room to say what it counts.
    status.text = '$(symbol-file) Wicker';
    status.tooltip = new vscode.MarkdownString(
      [
        all.length === 1 ? 'One Symfony project' : `${all.length} Symfony projects`,
        `${plural(templates, 'template')} that a reference can resolve to`,
        NAMESPACE_ORIGIN[source],
        '',
        'Click for detail.',
      ].join('\n\n'),
    );
    // Warn only when bundle namespaces are genuinely unknown. A remembered
    // answer resolves them correctly, so warning about it would train the
    // user to ignore the colour that matters.
    status.backgroundColor = source !== 'config'
      ? undefined
      : new vscode.ThemeColor('statusBarItem.warningBackground');
    status.show();
  };

  // Indexing reads the whole template tree, which on a large project or a
  // remote filesystem is past the point where silence reads as a hang.
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Wicker: indexing templates' },
    () => sessions.initialize(),
  );
  updateStatus();

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
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Wicker: rebuilding template index' },
        () => sessions.refreshAll(),
      );
      refreshAllDiagnostics();
      updateStatus();

      // Confirms the action without a dialog to dismiss.
      status.text = '$(check) Wicker';
      setTimeout(updateStatus, 2000);
    }),

    vscode.commands.registerCommand('wicker.showProjectInfo', () => {
      const all = sessions.all();
      if (all.length === 0) {
        // An empty state that says what was looked for and what to do, rather
        // than reporting a dead end.
        output.clear();
        output.appendLine('Wicker found no Symfony project in this workspace.');
        output.appendLine('');
        output.appendLine('A folder is treated as a Symfony application when it contains');
        output.appendLine('a composer.json alongside any one of:');
        output.appendLine('  - a symfony/framework-bundle requirement');
        output.appendLine('  - config/bundles.php');
        output.appendLine('  - src/Kernel.php');
        output.appendLine('');
        output.appendLine('A bin/console script or a symfony/ package alone is not enough,');
        output.appendLine('because those also describe a plain console tool or a library.');
        output.appendLine('');
        output.appendLine('If the project lives in a subfolder, open that folder or add it');
        output.appendLine('to the workspace.');
        output.show(true);
        return;
      }
      const lines = all.map((session) => {
        const namespaces = session.index
          .allNames()
          .filter((name) => name.startsWith('@'))
          .map((name) => name.slice(1, name.indexOf('/')));
        const loaderPaths = session.loaderPaths;
        const unavailable =
          loaderPaths.consoleError === undefined
            ? ''
            : ` (console unavailable: ${loaderPaths.consoleError})`;
        const origin =
          loaderPaths.source === 'console'
            ? 'bin/console debug:twig'
            : loaderPaths.source === 'remembered'
              ? `an earlier bin/console debug:twig, remembered${unavailable}`
              : `config/packages/twig.yaml${unavailable}`;

        return [
          session.project.root,
          // Both counts, because the badge shows files and a reader comparing
          // the two should not have to guess why they differ.
          `  templates      ${plural(session.index.fileCount, 'file')}, reachable under ${plural(
            session.index.nameCount,
            'name',
          )}${session.index.truncated ? ' (truncated at the configured limit)' : ''}`,
          `  namespaces     ${[...new Set(namespaces)].join(', ') || '(main only)'}`,
          `  read from      ${origin}`,
          `  detected by    ${session.project.evidence.join(', ')}`,
        ].join('\n');
      });

      // An output channel rather than a modal: the content is reference
      // material to read and copy, and a modal would block the editor to show
      // information nobody asked to be interrupted by.
      output.clear();
      output.appendLine(all.length === 1 ? 'Symfony project' : `${all.length} Symfony projects`);
      output.appendLine('');
      output.appendLine(lines.join('\n\n'));

      if (all.some((session) => session.loaderPaths.source === 'config')) {
        output.appendLine('');
        output.appendLine('Bundle namespaces such as @Twig are declared in no configuration');
        output.appendLine('file, so they can only be read from the console. Set');
        output.appendLine('wicker.console.command if PHP is not on this machine, for example:');
        output.appendLine('  ["docker", "exec", "my-php-1", "php", "bin/console"]');
      }
      output.show(true);
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
    sessions.onDidChange(() => {
      refreshAllDiagnostics();
      semanticTokens.refresh();
      updateStatus();
    }),

    semanticTokens,
    vscode.languages.registerDocumentSemanticTokensProvider(
      SELECTOR,
      semanticTokens,
      SEMANTIC_TOKENS_LEGEND,
    ),

    vscode.languages.registerCodeActionsProvider(
      SELECTOR,
      new CreateTemplateActionProvider(sessions),
      CreateTemplateActionProvider.metadata,
    ),
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

  const kind = describeKind(reference);

  const template = session.lookup(reference.templateName);
  if (template === undefined) {
    markdown.appendMarkdown(`**Template not found**\n\n`);
    markdown.appendMarkdown(`\`${reference.templateName}\` from ${articleFor(kind)} ${kind}.\n\n`);

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
  markdown.appendMarkdown(`Referenced by ${articleFor(kind)} ${kind}.`);

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

/** "1 template", "37 templates". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** How the tooltip explains each way the namespaces can have been obtained. */
const NAMESPACE_ORIGIN: Record<LoaderPathSource, string> = {
  console: 'Namespaces from `bin/console debug:twig`',
  remembered:
    'Namespaces remembered from an earlier run, because the console is not answering now. Bundle namespaces still resolve, but a bundle added since then is unknown.',
  config: 'Namespaces from `twig.yaml` only, so bundle namespaces are unknown',
};

/**
 * The least informed source among the open projects.
 *
 * A warning has to describe the project that is worst off. Reporting the best
 * of them would hide the one actually misbehaving.
 */
function weakestSource(sessions: readonly ProjectSession[]): LoaderPathSource {
  let weakest: LoaderPathSource = 'console';
  for (const session of sessions) {
    const source = session.loaderPaths.source;
    if (source === 'config') {
      return 'config';
    }
    if (source === 'remembered') {
      weakest = 'remembered';
    }
  }
  return weakest;
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
