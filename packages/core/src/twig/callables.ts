import type { OffsetRange } from '../php/templateReferences.js';
import { objectOf } from '../util/json.js';

import { tokenizeTwigExpression, type TwigExpressionToken } from './expressionLexer.js';
import { lexTwigRegions } from './twigLexer.js';

export type TwigCallableKind = 'filter' | 'function';

export interface TwigCallable {
  readonly name: string;
  readonly kind: TwigCallableKind;
  /** Symfony's reflection output, not necessarily a Twig call signature. */
  readonly reportedArguments: readonly string[] | undefined;
}

export interface TwigCallableGroup {
  readonly entries: readonly TwigCallable[];
  /** An incomplete response can suggest known names but cannot reject others. */
  readonly complete: boolean;
}

export interface TwigCallableCatalog {
  readonly filters: TwigCallableGroup;
  readonly functions: TwigCallableGroup;
}

const NAME = /^[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*$/;
const PATTERN_NAME = /^[a-zA-Z_\u0080-\uffff*][a-zA-Z0-9_\u0080-\uffff*]*$/;

/** Read only the small, documented debug:twig subset this feature needs. */
export function twigCallablesFromDebug(payload: unknown): TwigCallableCatalog {
  const object = objectOf(payload);
  return {
    filters: readGroup(object?.['filters'], 'filter'),
    functions: readGroup(object?.['functions'], 'function'),
  };
}


function readGroup(value: unknown, kind: TwigCallableKind): TwigCallableGroup {
  // PHP encodes an empty array as [], and a populated name map as an object.
  if (Array.isArray(value) && value.length === 0) {
    return { entries: [], complete: true };
  }
  const object = objectOf(value);
  if (object === undefined) {
    return { entries: [], complete: false };
  }
  const entries: TwigCallable[] = [];
  let complete = true;
  for (const [name, args] of Object.entries(object)) {
    if (name.length > 256 || !PATTERN_NAME.test(name) ||
        (args !== null && (!Array.isArray(args) || args.length > 128 ||
          !args.every((arg: unknown) => typeof arg === 'string' && arg.length <= 2048)))) {
      complete = false;
      continue;
    }
    entries.push({ name, kind, reportedArguments: args === null ? undefined : args as string[] });
  }
  return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)), complete };
}

export function callableGroup(catalog: TwigCallableCatalog, kind: TwigCallableKind): TwigCallableGroup {
  return kind === 'filter' ? catalog.filters : catalog.functions;
}

/** Exact registrations win; wildcard names are registrations, not insertable code. */
export function findTwigCallable(catalog: TwigCallableCatalog, kind: TwigCallableKind, name: string): TwigCallable | undefined {
  const entries = callableGroup(catalog, kind).entries;
  return entries.find((entry) => entry.name === name) ??
    entries.find((entry) => entry.name.includes('*') && wildcardMatches(entry.name, name));
}

function wildcardMatches(pattern: string, name: string): boolean {
  // A bounded glob matcher avoids a backtracking regex built from project data.
  const parts = pattern.split('*');
  const first = parts.shift() ?? '';
  const last = parts.pop() ?? '';
  if (!name.startsWith(first) || !name.endsWith(last)) {
    return false;
  }
  let cursor = first.length;
  const end = name.length - last.length;
  for (const part of parts) {
    const at = name.indexOf(part, cursor);
    if (at === -1 || at + part.length > end) {
      return false;
    }
    cursor = at + part.length;
  }
  return cursor <= end;
}

export interface TwigCallableContext {
  readonly kind: TwigCallableKind;
  readonly name: string;
  readonly range: OffsetRange;
}

interface Expression {
  readonly start: number;
  readonly end: number;
  readonly tokens: readonly TwigExpressionToken[];
  readonly apply: boolean;
}

const OPERATORS = new Set(['(', '[', ',', ':', '?', '??', '+', '-', '*', '/', '//', '%', '**', '~',
  '==', '!=', '<', '>', '<=', '>=', 'and', 'or', 'xor', 'not', 'in', 'matches', '..', '=', '=>', 'with']);
const RESERVED = new Set(['true', 'false', 'null', 'none', 'and', 'or', 'xor', 'not', 'in', 'is',
  'matches', 'starts', 'ends', 'with', 'has', 'some', 'every', 'as', 'only', 'ignore', 'missing']);

function expressions(source: string): { expressions: Expression[]; macros: Set<string> } {
  const result: Expression[] = [];
  const macros = new Set<string>();
  let verbatim = false;
  for (const region of lexTwigRegions(source)) {
    if (region.kind !== 'expression' && region.kind !== 'statement') {
      continue;
    }
    let tokens = tokenizeTwigExpression(source, region.innerStart, region.innerEnd);
    const tag = region.kind === 'statement' ? tokens[0]?.value : undefined;
    if (verbatim) {
      if (tag === 'endverbatim') { verbatim = false; }
      continue;
    }
    if (tag === 'verbatim') { verbatim = true; continue; }
    if (tag === 'from') {
      const index = tokens.findIndex((token) => token.value === 'import');
      for (let i = index + 1; index !== -1 && i < tokens.length; i++) {
        const token = tokens[i];
        if (token?.kind === 'name' && token.value !== 'as' && tokens[i + 1]?.value !== 'as') {
          macros.add(token.value);
        }
      }
    }
    let start = region.innerStart;
    if (tag !== undefined) {
      let skip = 1;
      if (tag === 'set' || tag === 'for') {
        const separator = tokens.findIndex((token) => token.value === (tag === 'set' ? '=' : 'in'));
        if (separator === -1) { continue; }
        skip = separator + 1;
      } else if (!['if', 'elseif', 'do', 'include', 'extends', 'embed', 'with', 'apply', 'autoescape', 'deprecated'].includes(tag)) {
        continue;
      }
      start = tokens[skip - 1]?.end ?? start;
      tokens = tokens.slice(skip);
    }
    result.push({ start, end: region.innerEnd, tokens, apply: tag === 'apply' });
  }
  return { expressions: result, macros };
}

function kindAt(expression: Expression, index: number): TwigCallableKind | undefined {
  const previous = expression.tokens[index - 1]?.value;
  if (previous === '|' || (index === 0 && expression.apply)) { return 'filter'; }
  if (previous === undefined || OPERATORS.has(previous)) {
    // `is not test(...)` is a test expression, not a function call.
    if (previous === 'not' && expression.tokens[index - 2]?.value === 'is') { return undefined; }
    return 'function';
  }
  return undefined;
}

/** Literal callable names only: methods, tests, macro imports and strings are excluded. */
export function scanTwigCallables(source: string): readonly TwigCallableContext[] {
  const parsed = expressions(source);
  const result: TwigCallableContext[] = [];
  for (const expression of parsed.expressions) {
    expression.tokens.forEach((token, index) => {
      if (token.kind !== 'name' || RESERVED.has(token.value)) { return; }
      const kind = kindAt(expression, index);
      if (kind === undefined || (kind === 'function' &&
          (expression.tokens[index + 1]?.value !== '(' || parsed.macros.has(token.value)))) { return; }
      result.push({ kind, name: token.value, range: { start: token.start, end: token.end } });
    });
  }
  return result;
}

/** A whole identifier or empty insertion point at a filter/function expression position. */
export function twigCallableContextAt(source: string, offset: number): TwigCallableContext | undefined {
  const parsed = expressions(source);
  const expression = parsed.expressions.find((item) => offset >= item.start && offset <= item.end);
  if (expression === undefined) { return undefined; }
  const tokens = expression.tokens;
  let index = tokens.findIndex((token) => token.kind === 'name' && offset >= token.start && offset <= token.end);
  const token = tokens[index];
  if (token === undefined) {
    if (tokens.some((item) => offset >= item.start && offset < item.end)) { return undefined; }
    index = tokens.findIndex((item) => item.start >= offset);
    if (index === -1) { index = tokens.length; }
  }
  const kind = kindAt(expression, index);
  if (kind === undefined || (token !== undefined &&
      (RESERVED.has(token.value) || (kind === 'function' && parsed.macros.has(token.value))))) { return undefined; }
  const next = tokens[token === undefined ? index : index + 1]?.value;
  if (next === ':' || next === '=' || next === '=>') { return undefined; }
  let after = token === undefined ? index : index + 1;
  while (tokens[after]?.kind === 'name' || tokens[after]?.value === ',') { after++; }
  if (tokens[after]?.value === ')' && tokens[after + 1]?.value === '=>') { return undefined; }
  // A bare mapping key is a label, while a function inside parentheses is an expression.
  const brackets: string[] = [];
  for (const item of tokens.slice(0, index)) {
    if (['(', '[', '{'].includes(item.value)) { brackets.push(item.value); }
    else if ([')', ']', '}'].includes(item.value)) { brackets.pop(); }
  }
  if (brackets.at(-1) === '{' && (tokens[index - 1]?.value === ',' || tokens[index - 1]?.value === '{')) {
    return undefined;
  }
  return { kind, name: token?.value ?? '', range: token === undefined
    ? { start: offset, end: offset } : { start: token.start, end: token.end } };
}

export function isConcreteTwigCallable(name: string): boolean { return NAME.test(name); }
