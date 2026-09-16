import * as vscode from 'vscode';

import {
  templateContextVariables,
  twigVariableContextAt,
  type TemplateContextVariable,
  type TwigContextVariable,
} from '@wicker/core';

import type { SessionManager } from './session.js';
import { rangeOf } from './ranges.js';

/** Variable name evidence from PHP, local Twig bindings and literal rendering paths. */
export class TwigVariableProvider implements vscode.CompletionItemProvider, vscode.HoverProvider {
  constructor(private readonly sessions: SessionManager) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
    if (this.sessions.sessionFor(document) === undefined) { return undefined; }
    const context = twigVariableContextAt(document.getText(), document.offsetAt(position), true);
    if (context === undefined) {
      return undefined;
    }
    const range = rangeOf(document, context.range);
    return this.sessions.contextVariablesFor(document, document.offsetAt(position))
      .map((variable) => {
        const item = new vscode.CompletionItem(variable.name, vscode.CompletionItemKind.Variable);
        item.range = range;
        const direct = this.directVariable(document, variable);
        item.detail = direct === undefined ? 'Wicker · Twig context' : 'Wicker · Controller context';
        item.documentation = direct === undefined ? twigDocumentation(variable) : variableDocumentation(direct);
        return item;
      });
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (this.sessions.sessionFor(document) === undefined) { return undefined; }
    const context = twigVariableContextAt(document.getText(), document.offsetAt(position), true);
    if (context === undefined || context.name === '') {
      return undefined;
    }
    const variable = this.sessions.contextVariablesFor(document, document.offsetAt(position)).find((candidate) => candidate.name === context.name);
    if (variable === undefined) {
      return undefined;
    }
    const direct = this.directVariable(document, variable);
    return new vscode.Hover(direct === undefined ? twigDocumentation(variable) : variableDocumentation(direct),
      rangeOf(document, context.range));
  }

  private directVariable(document: vscode.TextDocument, variable: TwigContextVariable): TemplateContextVariable | undefined {
    return variable.origins.every((origin) => origin.kind === 'controller' && origin.via.length === 0)
      ? templateContextVariables(this.sessions.renderSitesFor(document)).find((item) => item.name === variable.name) : undefined;
  }
}

function twigDocumentation(variable: TwigContextVariable): vscode.MarkdownString {
  const content = new vscode.MarkdownString();
  content.isTrusted = false;
  content.appendText(variable.name);
  content.appendMarkdown('\n\n**Twig context**\n\n');
  content.appendMarkdown('Possible sources in the indexed templates. Availability can depend on the caller and execution path.');
  for (const origin of variable.origins) {
    content.appendMarkdown('\n\n- ');
    content.appendText(`${origin.label} — ${origin.projectPath}`);
    for (const step of origin.via) {
      content.appendMarkdown('  \n  ');
      content.appendText(`via ${step.kind === 'include-function' ? 'include()' : step.kind} in ${step.projectPath}`);
    }
  }
  return content;
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
