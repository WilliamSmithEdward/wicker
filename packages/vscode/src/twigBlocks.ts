import * as vscode from 'vscode';

import { lexTwigRegions, scanTwigTemplateReferences, twigBlocks, twigEmbeds, type IndexedTemplate, type TwigBlock } from '@wicker/core';

import { frontendIndex } from './frontendProject.js';
import { enginePathOf } from './paths.js';
import { rangeInSource, rangeOf } from './ranges.js';
import type { ProjectSession, SessionManager } from './session.js';
import { severityFromSettings } from './severity.js';

/** A block definition, and the template it is written in. */
interface Definition { readonly template: IndexedTemplate; readonly source: string; readonly block: TwigBlock }

/** What a template inherits from: a literal name, one named at runtime, or nothing. */
interface Parent { readonly name?: string; readonly dynamic: boolean }

/** The chain above a template, and whether it could be read to its end. */
interface Chain { readonly definitions: readonly Definition[]; readonly complete: boolean }

/** The block under the cursor, and the chain it is read against. */
interface Located {
  readonly session: ProjectSession;
  readonly template: IndexedTemplate | undefined;
  readonly block: TwigBlock;
  readonly origin: vscode.Range;
  /** Where the ancestor walk starts: the layout this template extends, or the template an embed names. */
  readonly root: Parent;
}

/**
 * Twig inheritance, read both ways.
 *
 * A child's block overrides the nearest ancestor's block of that name, and
 * nothing in either file says so: the child names the layout on its first
 * line and never the block, and the layout does not know its children at
 * all. Definition goes up the chain, references go both ways, completion
 * offers the ancestors' names, and a block no ancestor defines is reported,
 * because Twig renders nothing for it and says nothing either.
 *
 * Sources come from the frontend index, which holds every template's text
 * with open buffers ahead of the disk, so an unsaved layout counts.
 */
export class TwigBlockProvider implements vscode.DefinitionProvider, vscode.HoverProvider, vscode.ReferenceProvider, vscode.CompletionItemProvider {
  constructor(private readonly sessions: SessionManager) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.LocationLink[] | undefined {
    const at = this.locate(document, position);
    const target = at && this.above(at)[0];
    if (!at || !target) { return undefined; }
    return [{ originSelectionRange: at.origin, targetUri: at.session.uriFor(target.template),
      targetRange: rangeInSource(target.source, target.block.range), targetSelectionRange: rangeInSource(target.source, target.block.nameRange) }];
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const at = this.locate(document, position);
    if (!at) { return undefined; }
    const nearest = this.above(at)[0];
    const below = this.below(at);
    const content = new vscode.MarkdownString();
    content.isTrusted = false;
    if (nearest) {
      content.appendText(`Overrides {% block ${at.block.name} %} in ${nearest.template.name}.`);
    } else if (at.root.dynamic) {
      content.appendText(`Extends a template named at runtime, so what {% block ${at.block.name} %} overrides cannot be known.`);
    } else if (at.root.name !== undefined) {
      content.appendText(`No ancestor of this template defines a block named "${at.block.name}", so Twig never renders it.`);
    } else {
      content.appendText(`Defines {% block ${at.block.name} %}.`);
    }
    if (below.length > 0) { content.appendText(`\n\nOverridden in ${[...new Set(below.map((entry) => entry.template.name))].join(', ')}.`); }
    return new vscode.Hover(content, at.origin);
  }

  provideReferences(document: vscode.TextDocument, position: vscode.Position): vscode.Location[] | undefined {
    const at = this.locate(document, position);
    if (!at) { return undefined; }
    return [new vscode.Location(document.uri, rangeOf(document, at.block.nameRange)),
      ...[...this.above(at), ...this.below(at)].map((entry) =>
        new vscode.Location(at.session.uriFor(entry.template), rangeInSource(entry.source, entry.block.nameRange)))];
  }

  /** Inside `{% block`, the names the ancestors declare and this template has not overridden yet. */
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const session = this.sessions.sessionFor(document);
    const path = session?.relativePathOf(enginePathOf(document.uri));
    if (!session || path === undefined) { return undefined; }
    const source = document.getText(), offset = document.offsetAt(position);
    const region = lexTwigRegions(source).find((entry) => entry.kind === 'statement' && offset >= entry.innerStart && offset <= entry.innerEnd);
    const typed = region && /^\s*block\s+(\w*)$/.exec(source.slice(region.innerStart, offset));
    if (!region || !typed) { return undefined; }

    const embed = twigEmbeds(source).find((entry) => offset >= entry.range.start && offset <= entry.range.end);
    const root = embed === undefined ? parentOf(source) : embedParent(embed.template);
    const defined = new Set(twigBlocks(source)
      .filter((block) => block.embed === embed?.template && !(offset >= block.nameRange.start && offset <= block.nameRange.end))
      .map((block) => block.name));
    const offered = new Map<string, Definition>();
    for (const entry of ancestorsOf(this.sessions, session, root).definitions) {
      if (!defined.has(entry.block.name) && !offered.has(entry.block.name)) { offered.set(entry.block.name, entry); }
    }
    const prefixStart = offset - (typed[1]?.length ?? 0);
    return [...offered.values()].map((entry) => {
      const item = new vscode.CompletionItem(entry.block.name, vscode.CompletionItemKind.Property);
      item.detail = 'Wicker · Twig block';
      item.documentation = `Overrides {% block ${entry.block.name} %} in ${entry.template.name}.`;
      item.range = new vscode.Range(document.positionAt(prefixStart), position);
      return item;
    });
  }

  /** The block whose name, or whose `parent()` call, sits under the cursor. */
  private locate(document: vscode.TextDocument, position: vscode.Position): Located | undefined {
    const session = this.sessions.sessionFor(document);
    const path = session?.relativePathOf(enginePathOf(document.uri));
    if (!session || path === undefined || !path.endsWith('.twig')) { return undefined; }
    const source = document.getText(), offset = document.offsetAt(position);
    const blocks = twigBlocks(source);
    let block = blocks.find((entry) => offset >= entry.nameRange.start && offset <= entry.nameRange.end);
    let origin = block && rangeOf(document, block.nameRange);
    if (block === undefined) {
      // `{{ parent() }}` names no block; it means the innermost one around it.
      const word = document.getWordRangeAtPosition(position, /parent(?=\s*\()/);
      if (word === undefined) { return undefined; }
      block = [...blocks].reverse().find((entry) => offset >= entry.range.start && offset <= entry.range.end);
      origin = word;
    }
    if (block === undefined || origin === undefined) { return undefined; }
    const template = session.index.namesForProjectPath(path).map((name) => session.lookup(name))
      .find((entry) => entry?.projectPath === path);
    return { session, template, block, origin, root: block.embed === undefined ? parentOf(source) : embedParent(block.embed) };
  }

  /** Definitions of the block above this one, nearest first. */
  private above(at: Located): Definition[] {
    return ancestorsOf(this.sessions, at.session, at.root).definitions.filter((entry) => entry.block.name === at.block.name);
  }

  /** Definitions of the block in the templates extending this one, however deep. */
  private below(at: Located): Definition[] {
    if (at.template === undefined || at.block.embed !== undefined) { return []; }
    const session = at.session;
    const index = frontendIndex(this.sessions, session);
    const found: Definition[] = [];
    const visited = new Set<string>([at.template.projectPath]);
    const queue = [at.template];
    for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
      for (const templateName of session.index.namesForProjectPath(current.projectPath)) {
        for (const childPath of index.extendedBy(templateName)) {
          if (visited.has(childPath)) { continue; }
          visited.add(childPath);
          const child = session.index.namesForProjectPath(childPath).map((entry) => session.lookup(entry))
            .find((entry) => entry?.projectPath === childPath);
          const source = index.get(childPath)?.source;
          if (child === undefined || source === undefined) { continue; }
          for (const block of twigBlocks(source)) {
            if (block.name === at.block.name && block.embed === undefined) { found.push({ template: child, source, block }); }
          }
          queue.push(child);
        }
      }
    }
    return found;
  }
}

/**
 * Reports a top-level block that no ancestor defines.
 *
 * In a template that extends another, only blocks the chain declares are
 * rendered; a misspelt one is dropped without a word. Blocks inside an embed
 * belong to the embedded template and are left alone, as is a template
 * whose chain cannot be read to its end.
 */
export function twigBlockDiagnostics(sessions: SessionManager, session: ProjectSession, document: vscode.TextDocument): vscode.Diagnostic[] {
  const severity = severityFromSettings('unknownBlock', 'warning');
  const path = session.relativePathOf(enginePathOf(document.uri));
  if (severity === undefined || path === undefined || !path.endsWith('.twig')) { return []; }
  const source = document.getText();
  const parent = parentOf(source);
  if (parent.name === undefined || parent.dynamic) { return []; }
  const chain = ancestorsOf(sessions, session, parent);
  if (!chain.complete) { return []; }
  const known = new Set(chain.definitions.map((entry) => entry.block.name));
  return twigBlocks(source).filter((block) => block.depth === 0 && block.embed === undefined && !known.has(block.name)).map((block) => {
    const diagnostic = new vscode.Diagnostic(rangeOf(document, block.nameRange),
      `Block "${block.name}" is defined by no ancestor of this template, so Twig never renders it.`, severity);
    diagnostic.source = 'wicker';
    diagnostic.code = 'unknown-block';
    return diagnostic;
  });
}

/**
 * Every block the chain above a template declares, nearest template first.
 *
 * A template's own blocks come before those it takes with `{% use %}`, and
 * both before its parent's. The walk is complete when it ends at a template
 * that extends nothing; it stops short at a template it cannot find, one
 * that names its parent at runtime, or a cycle.
 */
function ancestorsOf(sessions: SessionManager, session: ProjectSession, root: Parent): Chain {
  const index = frontendIndex(sessions, session);
  const definitions: Definition[] = [];
  const visited = new Set<string>();
  let next = root;
  while (next.name !== undefined) {
    const template = session.lookup(next.name);
    const source = template === undefined ? undefined : index.get(template.projectPath)?.source;
    if (template === undefined || source === undefined || visited.has(template.projectPath)) { return { definitions, complete: false }; }
    visited.add(template.projectPath);
    for (const block of twigBlocks(source)) {
      if (block.embed === undefined) { definitions.push({ template, source, block }); }
    }
    for (const used of usesOf(source)) {
      const usedTemplate = session.lookup(used);
      const usedSource = usedTemplate === undefined ? undefined : index.get(usedTemplate.projectPath)?.source;
      if (usedTemplate === undefined || usedSource === undefined) { continue; }
      for (const block of twigBlocks(usedSource)) {
        if (block.embed === undefined) { definitions.push({ template: usedTemplate, source: usedSource, block }); }
      }
    }
    next = parentOf(source);
  }
  return { definitions, complete: !next.dynamic };
}

/** What a template extends: nothing, a literal name, or one named at runtime. */
function parentOf(source: string): Parent {
  const found = scanTwigTemplateReferences(source).find((reference) => reference.kind === 'extends');
  if (found === undefined) { return { dynamic: dynamicExtends(source) }; }
  return found.isCandidateList ? { dynamic: true } : { name: found.templateName, dynamic: false };
}

/** An embed's blocks are read against the template it names, as a child's are against its layout. */
function embedParent(template: string): Parent {
  return template === '' ? { dynamic: true } : { name: template, dynamic: false };
}

/** An `{% extends %}` whose argument is not a literal, which the reference scan leaves out. */
function dynamicExtends(source: string): boolean {
  return lexTwigRegions(source).some((region) => region.kind === 'statement' && /^\s*extends\b/.test(source.slice(region.innerStart, region.innerEnd)));
}

function usesOf(source: string): string[] {
  return scanTwigTemplateReferences(source).filter((reference) => reference.kind === 'use' && !reference.isCandidateList)
    .map((reference) => reference.templateName);
}
