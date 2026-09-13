import * as vscode from 'vscode';

import {
  scanTemplateReferences,
  scanTwigTemplateReferences,
  type OffsetRange,
} from '@wicker/core';

/** A template reference found in a document, in editor coordinates. */
export interface DocumentTemplateReference {
  readonly templateName: string;
  /** Just the name, inside its quotes. What navigation and completion target. */
  readonly nameRange: vscode.Range;
  /** The whole call, tag, or attribute. Used for code lens placement. */
  readonly range: vscode.Range;
  readonly origin: 'php' | 'twig';
  /** How the template was referenced, for display. */
  readonly kind: string;
  /** Context keys passed with it, where the reference carries any. */
  readonly contextKeys: readonly string[];
  /** True when more context keys exist than are statically visible. */
  readonly contextIsDynamic: boolean;
  /**
   * True when the reference names one of several candidates Twig tries in
   * order. A missing file among those is not an error.
   */
  readonly isCandidateList: boolean;
  readonly className: string | undefined;
  readonly methodName: string | undefined;
}

interface CacheEntry {
  readonly version: number;
  readonly references: readonly DocumentTemplateReference[];
}

/**
 * Scans are cached per document version.
 *
 * Hover, definition, completion and diagnostics all ask for the same document
 * in quick succession, and parsing PHP on each of those would be wasteful. The
 * cache is keyed by version so an edit invalidates it immediately.
 */
const cache = new Map<string, CacheEntry>();

/** True for documents Wicker knows how to read. */
export function isSupported(document: vscode.TextDocument): boolean {
  return originOf(document) !== undefined;
}

function originOf(document: vscode.TextDocument): 'php' | 'twig' | undefined {
  if (document.languageId === 'php') {
    return 'php';
  }
  if (document.languageId === 'twig') {
    return 'twig';
  }
  // A .twig file opens as plaintext when no Twig language is contributed by
  // whichever extension the user has; fall back to the extension itself.
  if (document.uri.path.endsWith('.twig')) {
    return 'twig';
  }
  if (document.uri.path.endsWith('.php')) {
    return 'php';
  }
  return undefined;
}

/** Every template reference in a document. */
export function templateReferencesIn(
  document: vscode.TextDocument,
): readonly DocumentTemplateReference[] {
  const key = document.uri.toString();
  const cached = cache.get(key);
  if (cached !== undefined && cached.version === document.version) {
    return cached.references;
  }

  const references = scanDocument(document);
  cache.set(key, { version: document.version, references });
  return references;
}

/** The reference whose name contains a position, if the position is on one. */
export function templateReferenceAt(
  document: vscode.TextDocument,
  position: vscode.Position,
): DocumentTemplateReference | undefined {
  for (const reference of templateReferencesIn(document)) {
    // Inclusive of both ends so the caret at either quote still resolves.
    if (
      reference.nameRange.start.isBeforeOrEqual(position) &&
      reference.nameRange.end.isAfterOrEqual(position)
    ) {
      return reference;
    }
  }
  return undefined;
}

export function forgetDocument(uri: vscode.Uri): void {
  cache.delete(uri.toString());
}

export function clearCache(): void {
  cache.clear();
}

function scanDocument(document: vscode.TextDocument): readonly DocumentTemplateReference[] {
  const origin = originOf(document);
  if (origin === undefined) {
    return [];
  }
  const text = document.getText();
  const toRange = (range: OffsetRange): vscode.Range =>
    new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));

  if (origin === 'php') {
    const { references, parseFailed } = scanTemplateReferences(text);
    if (parseFailed) {
      // Keep whatever the last good scan produced rather than claiming the
      // file has no references; a file is unparseable for much of the time it
      // is being typed.
      return cache.get(document.uri.toString())?.references ?? [];
    }
    return references.map((reference) => ({
      templateName: reference.templateName,
      nameRange: toRange(reference.nameRange),
      range: toRange(reference.range),
      origin: 'php',
      kind: reference.kind,
      contextKeys: reference.contextKeys,
      contextIsDynamic: reference.contextIsDynamic,
      isCandidateList: false,
      className: reference.className,
      methodName: reference.methodName,
    }));
  }

  return scanTwigTemplateReferences(text).map((reference) => ({
    templateName: reference.templateName,
    nameRange: toRange(reference.nameRange),
    range: toRange(reference.range),
    origin: 'twig',
    kind: reference.kind,
    contextKeys: [],
    contextIsDynamic: false,
    isCandidateList: reference.isCandidateList,
    className: undefined,
    methodName: undefined,
  }));
}

/** Human-readable label for a reference kind, used in hovers. */
export function describeKind(reference: DocumentTemplateReference): string {
  switch (reference.kind) {
    case 'template-attribute':
      return '#[Template] attribute';
    case 'include-function':
      return 'include() function';
    case 'source-function':
      return 'source() function';
    case 'render':
    case 'renderView':
    case 'renderBlock':
    case 'renderBlockView':
    case 'renderForm':
    case 'stream':
      return `${reference.kind}() call`;
    default:
      return `{% ${reference.kind} %} tag`;
  }
}
