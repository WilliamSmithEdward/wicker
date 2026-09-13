import * as vscode from 'vscode';

import {
  parseTemplateName,
  type IndexedTemplate,
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
import { RenderedByProvider } from './renderedBy.js';
import {
  SEMANTIC_TOKENS_LEGEND,
  TemplateSemanticTokensProvider,
} from './semanticTokens.js';
import { SessionManager, type ProjectSession } from './session.js';
import { WickerSidebar, type SidebarNode } from './sidebar.js';
import { TwigVariableProvider } from './twigVariables.js';

const TWIG_SELECTOR: vscode.DocumentSelector = [
  { language: 'twig', scheme: 'file' },
  { pattern: '**/*.twig', scheme: 'file' },
];

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
  const renderedBy = new RenderedByProvider(sessions);
  const twigVariables = new TwigVariableProvider(sessions);
  const sidebar = new WickerSidebar(sessions, context.workspaceState);
  const output = vscode.window.createOutputChannel('Wicker');
  const diagnostics = vscode.languages.createDiagnosticCollection('wicker');

  context.subscriptions.push(sessions, output, diagnostics, renderedBy, sidebar);

  // Indexing reads the whole template tree, which on a large project or a
  // remote filesystem is past the point where silence reads as a hang.
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Wicker: indexing templates' },
    () => sessions.initialize(),
  );
  sidebar.finishLoading();

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
    vscode.languages.registerCodeLensProvider(
      TWIG_SELECTOR,
      renderedBy,
    ),
    vscode.languages.registerCompletionItemProvider(TWIG_SELECTOR, twigVariables),
    vscode.languages.registerHoverProvider(TWIG_SELECTOR, twigVariables),
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
    }),

    vscode.commands.registerCommand('wicker.showProjectInfo', (node?: SidebarNode) => {
      let all = sessions.all();
      if (node !== undefined) {
        if (node.kind !== 'project') {
          return;
        }
        const session = sessions.sessionFor({ uri: node.root });
        if (session?.fileSystem.toUri(session.project.root).toString() !== node.root.toString()) {
          return;
        }
        all = [session];
      }
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
          // A file can resolve under more than one template name.
          `  templates      ${plural(session.index.fileCount, 'file')}, reachable under ${plural(
            session.index.nameCount,
            'name',
          )}${session.index.truncated ? ' (truncated at the configured limit)' : ''}`,
          `  namespaces     ${[...new Set(namespaces)].join(', ') || '(main only)'}`,
          `  read from      ${origin}`,
          `  detected by    ${session.project.evidence.join(', ')}`,
        ].join('\n');
      });

      let report = `${all.length === 1 ? 'Symfony project' : `${all.length} Symfony projects`}\n\n${lines.join('\n\n')}`;
      if (all.some((session) => session.loaderPaths.source === 'config')) {
        report += '\n\nBundle namespaces such as @Twig are declared in no configuration\n' +
          'file, so they can only be read from the console. Set\n' +
          'wicker.console.command if PHP is not on this machine, for example:\n' +
          '  ["docker", "exec", "my-php-1", "php", "bin/console"]';
      }
      output.clear();
      output.appendLine(report);
      output.show(true);
      return report;
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
        // Toggling wicker.enable has to refresh colouring as well as diagnostics.
        semanticTokens.refresh();
      }
    }),
    // The index changing can turn a missing template into a found one.
    sessions.onDidChange(() => {
      refreshAllDiagnostics();
      semanticTokens.refresh();
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
