/**
 * Finding the places a Twig template names another Twig template.
 *
 * This is the other half of the bridge from the PHP scanner. Most templates in
 * a real project are never named by a controller at all: they are reached
 * through extends and include, and without this they would look like orphans.
 */

import { lexTwigRegions, readStringLiterals } from './twigLexer.js';

export interface OffsetRange {
  readonly start: number;
  readonly end: number;
}

export type TwigReferenceKind =
  | 'extends'
  | 'include'
  | 'embed'
  | 'use'
  | 'import'
  | 'from'
  | 'include-function'
  | 'source-function';

export interface TwigTemplateReference {
  readonly templateName: string;
  /** Offsets of the name inside its quotes. */
  readonly nameRange: OffsetRange;
  /** Offsets of the whole tag or call. */
  readonly range: OffsetRange;
  readonly kind: TwigReferenceKind;
  /**
   * True when the reference is one of several candidates Twig will try in
   * order, as in `{% include ['a.twig', 'b.twig'] %}`. A missing file is not
   * an error in that case, so diagnostics must treat these differently.
   */
  readonly isCandidateList: boolean;
}

/** Tags whose template name is the first expression after the tag name. */
const LEADING_NAME_TAGS: ReadonlyMap<string, TwigReferenceKind> = new Map([
  ['extends', 'extends'],
  ['include', 'include'],
  ['embed', 'embed'],
  ['use', 'use'],
  ['import', 'import'],
]);

/** Functions whose first argument is a template name. */
const TEMPLATE_FUNCTIONS: ReadonlyMap<string, TwigReferenceKind> = new Map([
  ['include', 'include-function'],
  ['source', 'source-function'],
]);

/**
 * Scans Twig source for references to other templates.
 *
 * Only literal names are reported. `{% extends someVariable %}` and
 * `{% include "page/" ~ slug ~ ".twig" %}` are skipped rather than guessed at.
 */
export function scanTwigTemplateReferences(source: string): readonly TwigTemplateReference[] {
  const references: TwigTemplateReference[] = [];

  for (const region of lexTwigRegions(source)) {
    if (region.kind === 'statement') {
      collectFromStatement(source, region.innerStart, region.innerEnd, region, references);
    } else if (region.kind === 'expression') {
      collectFromExpression(source, region.innerStart, region.innerEnd, region, references);
    }
    // Text and comment regions never name a template.
  }

  return references;
}

interface RegionBounds {
  readonly start: number;
  readonly end: number;
}

function collectFromStatement(
  source: string,
  innerStart: number,
  innerEnd: number,
  region: RegionBounds,
  into: TwigTemplateReference[],
): void {
  const body = source.slice(innerStart, innerEnd);
  const tagMatch = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)/.exec(body);
  const tagName = tagMatch?.[1];
  if (tagName === undefined) {
    return;
  }

  // `{% from 'x.twig' import y %}` names its template after the tag, like the
  // others, so it shares the leading-name handling.
  const kind = LEADING_NAME_TAGS.get(tagName) ?? (tagName === 'from' ? 'from' : undefined);
  if (kind === undefined) {
    return;
  }

  const afterTag = innerStart + (tagMatch?.[0].length ?? 0);
  const expressionEnd = boundExpression(source, afterTag, innerEnd, kind);

  // `{% import %}` and `{% from %}` may name the current template as `_self`,
  // which is a keyword rather than a file.
  if (/^\s*_self\b/.test(source.slice(afterTag, expressionEnd))) {
    return;
  }

  const shape = classifyExpression(source, afterTag, expressionEnd);
  if (shape === 'dynamic') {
    return;
  }

  const literals = readStringLiterals(source, afterTag, expressionEnd);
  if (literals.length === 0) {
    return;
  }

  for (const literal of literals) {
    into.push({
      templateName: literal.value,
      nameRange: { start: literal.start, end: literal.end },
      range: { start: region.start, end: region.end },
      kind,
      isCandidateList: shape === 'candidates',
    });
    if (shape === 'single') {
      // Only the first literal is the template; anything later belongs to
      // `with`, `only`, or an import alias.
      break;
    }
  }
}

type ExpressionShape = 'single' | 'candidates' | 'dynamic';

/**
 * Decides how a template expression should be read.
 *
 * Strings are masked first so that operators can be found without a quoted
 * `~` or `?` inside a filename being mistaken for one.
 *
 * - Concatenation makes the name unknowable, so it is dynamic and skipped.
 *   Reporting the leading fragment of `'page/' ~ slug` as a template would be
 *   a confident wrong answer.
 * - A bracketed list, or a ternary, names several templates Twig may load, so
 *   every literal is reported as a candidate.
 */
function classifyExpression(source: string, from: number, to: number): ExpressionShape {
  const masked = maskStringContents(source.slice(from, to));

  if (masked.includes('~')) {
    return 'dynamic';
  }
  if (/^\s*\[/.test(masked) || masked.includes('?')) {
    return 'candidates';
  }
  return 'single';
}

/**
 * Replaces the contents of every string literal with spaces, preserving
 * offsets so the result can be scanned for operators safely.
 */
function maskStringContents(text: string): string {
  let masked = '';
  let quote: string | undefined;

  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const char = text[cursor] ?? '';
    if (quote !== undefined) {
      if (char === '\\') {
        masked += '  ';
        cursor += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        masked += char;
        continue;
      }
      masked += ' ';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    }
    masked += char;
  }
  return masked;
}

/**
 * Limits how far a tag's template expression runs.
 *
 * `{% include 'a.twig' with { title: 'b.twig' } %}` must not treat the value
 * inside `with` as a second template, so the expression stops at the first
 * keyword that ends it.
 */
function boundExpression(
  source: string,
  from: number,
  to: number,
  kind: TwigReferenceKind,
): number {
  const terminators = kind === 'from' ? [' import '] : [' with ', ' only', ' ignore missing', ' as '];
  const body = source.slice(from, to);

  let limit = body.length;
  for (const terminator of terminators) {
    const at = body.indexOf(terminator);
    if (at !== -1 && at < limit) {
      limit = at;
    }
  }
  return from + limit;
}

function collectFromExpression(
  source: string,
  innerStart: number,
  innerEnd: number,
  region: RegionBounds,
  into: TwigTemplateReference[],
): void {
  const body = source.slice(innerStart, innerEnd);
  const callPattern = /\b(include|source)\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(body)) !== null) {
    const functionName = match[1];
    if (functionName === undefined) {
      continue;
    }
    const kind = TEMPLATE_FUNCTIONS.get(functionName);
    if (kind === undefined) {
      continue;
    }

    const argumentsStart = innerStart + match.index + match[0].length;
    const argumentsEnd = findMatchingParenthesis(source, argumentsStart, innerEnd);
    const firstArgumentEnd = boundFirstArgument(source, argumentsStart, argumentsEnd);

    const shape = classifyExpression(source, argumentsStart, firstArgumentEnd);
    if (shape === 'dynamic') {
      continue;
    }

    const literals = readStringLiterals(source, argumentsStart, firstArgumentEnd);
    if (literals.length === 0) {
      continue;
    }

    for (const literal of shape === 'single' ? literals.slice(0, 1) : literals) {
      into.push({
        templateName: literal.value,
        nameRange: { start: literal.start, end: literal.end },
        range: { start: region.start, end: region.end },
        kind,
        isCandidateList: shape === 'candidates',
      });
    }
  }
}

/**
 * Offset of the first character outside a string literal that `stopAt`
 * accepts, or `to`. Escapes inside a literal are honoured, so a quote after
 * a backslash does not end it.
 */
function scanOutsideQuotes(source: string, from: number, to: number, stopAt: (char: string | undefined) => boolean): number {
  let quote: string | undefined;

  for (let cursor = from; cursor < to; cursor += 1) {
    const char = source[cursor];
    if (quote !== undefined) {
      if (char === '\\') {
        cursor += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (stopAt(char)) {
      return cursor;
    }
  }
  return to;
}

/** Offset of the parenthesis closing the one just opened, or `to`. */
function findMatchingParenthesis(source: string, from: number, to: number): number {
  let depth = 1;
  return scanOutsideQuotes(source, from, to, (char) => {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    }
    return depth === 0;
  });
}

/** Offset where the first argument ends, at the top-level comma if there is one. */
function boundFirstArgument(source: string, from: number, to: number): number {
  let depth = 0;
  return scanOutsideQuotes(source, from, to, (char) => {
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
    }
    return char === ',' && depth === 0;
  });
}
