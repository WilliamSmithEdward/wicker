import * as vscode from 'vscode';

import {
  templateContextVariables,
  twigVariableContextAt,
  type TemplateContextVariable,
} from '@wicker/core';

import type { SessionManager } from './session.js';

/** Controller keys at root-variable positions in directly rendered templates. */
export class TwigVariableProvider implements vscode.CompletionItemProvider, vscode.HoverProvider {
  constructor(private readonly sessions: SessionManager) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const sites = this.sessions.renderSitesFor(document);
    if (sites.length === 0) {
      return undefined;
    }
    const context = twigVariableContextAt(document.getText(), document.offsetAt(position));
    if (context === undefined) {
      return undefined;
    }
    const range = new vscode.Range(document.positionAt(context.range.start), document.positionAt(context.range.end));
    return templateContextVariables(sites).filter((variable) => !context.localNames.has(variable.name))
      .map((variable) => {
        const item = new vscode.CompletionItem(variable.name, vscode.CompletionItemKind.Variable);
        item.range = range;
        item.detail = 'Wicker · Controller context';
        item.documentation = variableDocumentation(variable);
        return item;
      });
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const sites = this.sessions.renderSitesFor(document);
    if (sites.length === 0) {
      return undefined;
    }
    const context = twigVariableContextAt(document.getText(), document.offsetAt(position));
    if (context === undefined || context.name === '' || context.localNames.has(context.name)) {
      return undefined;
    }
    const variable = templateContextVariables(sites).find((candidate) => candidate.name === context.name);
    if (variable === undefined) {
      return undefined;
    }
    return new vscode.Hover(variableDocumentation(variable), new vscode.Range(
      document.positionAt(context.range.start), document.positionAt(context.range.end),
    ));
  }
}

function variableDocumentation(variable: TemplateContextVariable): vscode.MarkdownString {
  const content = new vscode.MarkdownString();
  content.appendText(variable.name);
  content.appendMarkdown('\n\n**Controller context**\n\n');
  content.appendMarkdown(`Explicitly passed at ${variable.sources.length} of ${variable.renderSiteCount} indexed render sites.`);
  if (variable.sources.length < variable.renderSiteCount) {
    content.appendMarkdown('\n\n');
    content.appendMarkdown('Other render sites may omit this variable or supply it dynamically.');
  }
  for (const site of variable.sources) {
    const owner = site.className?.split('\\').at(-1) ?? site.projectPath;
    const label = site.methodName === undefined ? owner : `${owner}::${site.methodName}`;
    content.appendMarkdown('\n\n- ');
    content.appendText(`${label} — ${site.kind === 'template-attribute' ? '#[Template]' : `${site.kind}()`}`);
    content.appendMarkdown('  \n  ');
    content.appendText(site.projectPath);
  }
  return content;
}
