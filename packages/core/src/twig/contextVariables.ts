import type { RenderSite } from '../php/renderSiteIndex.js';
import type { OffsetRange } from '../php/templateReferences.js';

import { lexTwigRegions } from './twigLexer.js';

const NAME = /^[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*$/;
const RESERVED = new Set([
  'true', 'false', 'null', 'none', 'and', 'or', 'xor', 'not', 'in', 'is',
  'matches', 'starts', 'ends', 'with', 'has', 'some', 'every', 'b-and', 'b-or',
  'b-xor', 'as', 'only', 'ignore', 'missing', '_context', '_self', '_charset',
]);

export interface TemplateContextVariable {
  readonly name: string;
  readonly sources: readonly RenderSite[];
  readonly renderSiteCount: number;
}

/** Literal keys are evidence of a supplied name, never evidence of its type. */
export function templateContextVariables(sites: readonly RenderSite[]): readonly TemplateContextVariable[] {
  const byName = new Map<string, RenderSite[]>();
  for (const site of sites) {
    for (const name of new Set(site.contextKeys)) {
      if (!NAME.test(name) || RESERVED.has(name.toLowerCase())) {
        continue;
      }
      const sources = byName.get(name) ?? [];
      sources.push(site);
      byName.set(name, sources);
    }
  }
  return [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, sources]) => ({
    name, sources, renderSiteCount: sites.length,
  }));
}

interface Token extends OffsetRange {
  readonly value: string;
  readonly kind: 'name' | 'string' | 'number' | 'punctuation';
}

export interface TwigVariableContext {
  /** Whole identifier, or an empty range at a position expecting an expression. */
  readonly range: OffsetRange;
  readonly name: string;
  readonly localNames: ReadonlySet<string>;
}

interface Scope {
  readonly tag: string;
  readonly names: Set<string>;
  readonly assigned: Set<string>;
  readonly isolated: boolean;
}

/**
 * A conservative expression-position reader, not a Twig type checker. Local
 * bindings hide controller names; uncertain scopes and arrow expressions are
 * omitted until we can resolve them. No runtime parser is shipped with Wicker.
 */
export function twigVariableContextAt(source: string, offset: number): TwigVariableContext | undefined {
  const scopes: Scope[] = [{ tag: '', names: new Set(), assigned: new Set(), isolated: false }];
  let verbatim = false;
  for (const region of lexTwigRegions(source)) {
    if (region.start > offset) {
      break;
    }
    if (region.kind !== 'statement' && region.kind !== 'expression') {
      continue;
    }
    const tokens = tokenize(source, region.innerStart, region.innerEnd);
    const tag = region.kind === 'statement' ? tokens[0]?.value : undefined;
    if (verbatim) {
      if (tag === 'endverbatim') {
        verbatim = false;
      }
      continue;
    }
    if (tag === 'verbatim') {
      verbatim = true;
      continue;
    }
    if (offset >= region.innerStart && offset <= region.innerEnd) {
      if (scopes.some((scope) => scope.isolated)) {
        return undefined;
      }
      const expression = expressionTokens(tokens, tag, offset);
      const range = expression === undefined ? undefined : variableRange(expression, offset);
      if (range === undefined) {
        return undefined;
      }
      return {
        range, name: source.slice(range.start, range.end),
        localNames: new Set(scopes.flatMap((scope) => [...scope.names])),
      };
    }
    if (tag !== undefined && region.end <= offset) {
      updateScopes(scopes, tokens, tag);
    }
  }
  return undefined;
}

function tokenize(source: string, start: number, end: number): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s+|[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*|\d+(?:\.\d+)?|\?\.|=>|==|!=|<=|>=|\?\?|\.\.|\*\*|\/\/|./gy;
  const text = source.slice(0, end);
  let cursor = start;
  while (cursor < end) {
    const char = source[cursor];
    if (char === "'" || char === '"') {
      const from = cursor++;
      while (cursor < end) {
        const current = source[cursor++];
        if (current === '\\') {
          cursor = Math.min(end, cursor + 1);
        } else if (current === char) {
          break;
        }
      }
      tokens.push({ value: source.slice(from, cursor), start: from, end: cursor, kind: 'string' });
      continue;
    }
    pattern.lastIndex = cursor;
    const match = pattern.exec(text);
    if (match === null) {
      break;
    }
    const value = match[0];
    const from = cursor;
    cursor += value.length;
    if (!/^\s+$/.test(value)) {
      tokens.push({ value, start: from, end: cursor,
        kind: NAME.test(value) ? 'name' : /^\d/.test(value) ? 'number' : 'punctuation' });
    }
  }
  return tokens;
}

/** Only tag positions whose expression grammar we understand are offered. */
function expressionTokens(tokens: readonly Token[], tag: string | undefined, offset: number): readonly Token[] | undefined {
  if (tag === undefined) {
    return tokens;
  }
  if (offset <= (tokens[0]?.end ?? offset)) {
    return undefined;
  }
  if (['if', 'elseif', 'do'].includes(tag)) {
    return tokens.slice(1);
  }
  if (tag === 'for' || tag === 'set') {
    const separator = tokens.findIndex((token) => token.value === (tag === 'for' ? 'in' : '='));
    return separator === -1 || offset <= (tokens[separator]?.end ?? offset)
      ? undefined : tokens.slice(separator + 1);
  }
  // Includes and inheritance are not followed to infer additional variables.
  if (['include', 'extends', 'embed', 'with'].includes(tag)) {
    return tokens.slice(1);
  }
  return undefined;
}

function variableRange(tokens: readonly Token[], offset: number): OffsetRange | undefined {
  // Lambdas and assignment expressions introduce bindings in this same region.
  // Suppress them rather than wrongly credit a controller for a local value.
  if (tokens.some((token) => token.value === '=>' || token.value === '=')) {
    return undefined;
  }
  const index = tokens.findIndex((token) => offset >= token.start && offset <= token.end && token.kind === 'name');
  const current = index === -1 ? undefined : tokens[index];
  if (current !== undefined && RESERVED.has(current.value.toLowerCase())) {
    return undefined;
  }
  const before = tokens.filter((token) => token.end <= (current?.start ?? offset));
  const previous = before.at(-1)?.value;
  const next = current === undefined ? tokens.find((token) => token.start >= offset)?.value : tokens[index + 1]?.value;
  if (tokens.some((token) => token !== current && offset >= token.start && offset < token.end)) {
    return undefined;
  }
  if (next === '(' || next === '=' || next === '=>') {
    return undefined;
  }
  if (previous === '.' || previous === '?.' || previous === '|' || previous === 'is' ||
      (previous === 'not' && before.at(-2)?.value === 'is')) {
    return undefined;
  }
  const operators = new Set(['(', '[', ',', ':', '?', '??', '+', '-', '*', '/', '//', '%', '**', '~',
    '==', '!=', '<', '>', '<=', '>=', 'and', 'or', 'xor', 'not', 'in', 'matches', '..', 'with']);
  if (previous !== undefined && !operators.has(previous)) {
    return undefined;
  }
  const brackets: string[] = [];
  for (const token of before) {
    if (['(', '[', '{'].includes(token.value)) {
      brackets.push(token.value);
    } else if ([')', ']', '}'].includes(token.value)) {
      brackets.pop();
    }
  }
  // Mapping keys and named arguments are labels, not root variable reads.
  if ((previous === ',' && brackets.at(-1) === '{') ||
      (next === ':' && brackets.at(-1) === '(')) {
    return undefined;
  }
  return current === undefined ? { start: offset, end: offset } : { start: current.start, end: current.end };
}

function updateScopes(scopes: Scope[], tokens: readonly Token[], tag: string): void {
  const scope = scopes.at(-1);
  if (scope === undefined) {
    return;
  }
  const assign = (names: readonly string[]): void => {
    for (const name of names) {
      scope.names.add(name);
      scope.assigned.add(name);
    }
  };
  if (tag.startsWith('end')) {
    if (scope.tag === tag.slice(3)) {
      scopes.pop();
      const parent = scopes.at(-1);
      // A loop can change an existing context key even when its binding is local.
      if (parent !== undefined && (scope.tag === 'for' || scope.tag === 'set')) {
        for (const name of scope.assigned) {
          parent.names.add(name);
          parent.assigned.add(name);
        }
      }
    }
    return;
  }
  if (tag === 'set') {
    const equals = tokens.findIndex((token) => token.value === '=');
    const names = tokens.slice(1, equals === -1 ? undefined : equals)
      .filter((token) => token.kind === 'name').map((token) => token.value);
    if (equals !== -1) {
      assign(names);
    } else {
      scopes.push({ tag, names: new Set(), assigned: new Set(names), isolated: false });
    }
  } else if (tag === 'for') {
    const separator = tokens.findIndex((token) => token.value === 'in');
    const names = tokens.slice(1, separator === -1 ? undefined : separator)
      .filter((token) => token.kind === 'name').map((token) => token.value);
    scopes.push({ tag, names: new Set([...names, 'loop']), assigned: new Set(), isolated: false });
  } else if (tag === 'macro' || tag === 'block' || tag === 'with' || tag === 'embed') {
    // A dynamic with-map could replace any key. Leave this scope unclaimed.
    const withAt = tag === 'with' ? 0 : tokens.findIndex((token) => token.value === 'with');
    const hasContext = withAt !== -1;
    const names = new Set<string>();
    if (hasContext) {
      for (let i = withAt + 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token !== undefined && tokens[i + 1]?.value === ':' &&
            (token.kind === 'name' || token.kind === 'string')) {
          names.add(token.kind === 'string' ? token.value.slice(1, -1) : token.value);
        }
      }
    }
    scopes.push({ tag, names, assigned: new Set(),
      isolated: tag === 'macro' || tokens.some((token) => token.value === 'only') ||
        (hasContext && (tokens[withAt + 1]?.value !== '{' ||
          tokens.some((token) => token.value === '..' || token.value === '(' ||
            (token.kind === 'string' && /\\|#\{/.test(token.value))))) });
  } else if (tag === 'do') {
    assign(tokens.filter((token, i) => token.kind === 'name' && tokens[i + 1]?.value === '=')
      .map((token) => token.value));
  } else if (tag === 'import' || tag === 'from') {
    const separator = tokens.findIndex((token) => token.value === (tag === 'import' ? 'as' : 'import'));
    assign(tokens.slice(separator + 1).filter((token, i, rest) => token.kind === 'name' &&
      token.value !== 'as' && rest[i + 1]?.value !== 'as').map((token) => token.value));
  }
}
