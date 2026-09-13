import type { RenderSite } from '../php/renderSiteIndex.js';
import type { OffsetRange } from '../php/templateReferences.js';

import { lexTwigRegions } from './twigLexer.js';
import { tokenizeTwigExpression as tokenize, type TwigExpressionToken as Token } from './expressionLexer.js';
import { splitTwigTokens, twigContextMap, type ContextKey } from './contextSyntax.js';

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

export interface TwigVariableContext {
  /** Whole identifier, or an empty range at a position expecting an expression. */
  readonly range: OffsetRange;
  readonly name: string;
  readonly localNames: ReadonlySet<string>;
  readonly bindings: readonly TwigLocalBinding[];
  readonly isolated: boolean;
  readonly blockName: string | undefined;
}

export interface TwigLocalBinding extends ContextKey {
  readonly kind: 'set' | 'loop' | 'macro' | 'with' | 'import';
}

export interface TwigScope {
  readonly localNames: ReadonlySet<string>;
  readonly bindings: readonly TwigLocalBinding[];
  readonly isolated: boolean;
  readonly blockName: string | undefined;
}

interface Scope {
  readonly tag: string;
  readonly names: Set<string>;
  readonly assigned: Set<string>;
  readonly isolated: boolean;
  readonly bindings: Map<string, TwigLocalBinding>;
  readonly assignments: Map<string, TwigLocalBinding>;
  readonly blockName?: string;
}

/**
 * A conservative expression-position reader, not a Twig type checker. Local
 * bindings hide controller names; uncertain scopes and arrow expressions are
 * omitted until we can resolve them. No runtime parser is shipped with Wicker.
 */
export function twigVariableContextAt(source: string, offset: number, allowIsolated = false): TwigVariableContext | undefined {
  const scope = twigScopeAt(source, offset);
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
      if (scope.isolated && !allowIsolated) {
        return undefined;
      }
      const expression = expressionTokens(tokens, tag, offset);
      const range = expression === undefined ? undefined : variableRange(expression, offset);
      if (range === undefined) {
        return undefined;
      }
      return {
        range, name: source.slice(range.start, range.end),
        ...scope,
      };
    }
  }
  return undefined;
}

/** Bindings visible before a source position; closed scopes cannot leak local names. */
export function twigScopeAt(source: string, offset: number): TwigScope {
  const scopes: Scope[] = [newScope('')];
  let verbatim = false;
  for (const region of lexTwigRegions(source)) {
    if (region.end > offset) { break; }
    if (region.kind !== 'statement') { continue; }
    const tokens = tokenize(source, region.innerStart, region.innerEnd);
    const tag = tokens[0]?.value;
    if (verbatim) { if (tag === 'endverbatim') { verbatim = false; } continue; }
    if (tag === 'verbatim') { verbatim = true; continue; }
    if (tag !== undefined) { updateScopes(scopes, tokens, tag); }
  }
  const active = scopes.slice(Math.max(0, scopes.map((scope) => scope.isolated).lastIndexOf(true)));
  const bindings = new Map<string, TwigLocalBinding>();
  for (const scope of active) { for (const [name, binding] of scope.bindings) { bindings.set(name, binding); } }
  return {
    localNames: new Set(active.flatMap((scope) => [...scope.names])),
    bindings: [...bindings.values()], isolated: scopes.some((scope) => scope.isolated),
    blockName: [...active].reverse().find((scope) => scope.blockName !== undefined)?.blockName,
  };
}

function newScope(tag: string, isolated = false): Scope {
  return { tag, names: new Set(), assigned: new Set(), isolated, bindings: new Map(), assignments: new Map() };
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
  const assign = (names: readonly string[], kind: TwigLocalBinding['kind'] = 'set'): void => {
    for (const name of names) {
      scope.names.add(name);
      scope.assigned.add(name);
      const token = tokens.find((token) => token.value === name);
      if (token !== undefined) {
        const binding = { name, kind, range: { start: token.start, end: token.end } };
        scope.bindings.set(name, binding);
        scope.assignments.set(name, binding);
      }
    }
  };
  if (tag.startsWith('end')) {
    if (scope.tag === tag.slice(3)) {
      scopes.pop();
      const parent = scopes.at(-1);
      // A loop can change an existing context key even when its binding is local.
      if (parent !== undefined && ['for', 'set', 'if'].includes(scope.tag)) {
        for (const name of scope.assigned) {
          parent.names.add(name);
          parent.assigned.add(name);
          const binding = scope.assignments.get(name);
          if (binding !== undefined && (scope.tag !== 'for' || parent.bindings.has(name))) {
            parent.bindings.set(name, binding);
            parent.assignments.set(name, binding);
          }
        }
      }
    }
    return;
  }
  if (tag === 'set') {
    const equals = tokens.findIndex((token) => token.value === '=');
    const filter = tokens.findIndex((token) => token.value === '|');
    const names = tokens.slice(1, equals === -1 ? (filter === -1 ? undefined : filter) : equals)
      .filter((token) => token.kind === 'name').map((token) => token.value);
    if (equals !== -1) {
      assign(names);
    } else {
      const capture = newScope(tag);
      for (const name of names) {
        capture.assigned.add(name);
        const token = tokens.find((token) => token.value === name)!;
        capture.assignments.set(name, { name, kind: 'set', range: { start: token.start, end: token.end } });
      }
      scopes.push(capture);
    }
  } else if (tag === 'for') {
    const separator = tokens.findIndex((token) => token.value === 'in');
    const names = tokens.slice(1, separator === -1 ? undefined : separator)
      .filter((token) => token.kind === 'name').map((token) => token.value);
    const loop = newScope(tag);
    for (const name of [...names, 'loop']) {
      const token = tokens.find((token) => token.value === name) ?? tokens[0]!;
      loop.names.add(name);
      loop.bindings.set(name, { name, kind: 'loop', range: { start: token.start, end: token.end } });
    }
    scopes.push(loop);
  } else if (tag === 'if') {
    scopes.push(newScope(tag));
  } else if ((tag === 'else' || tag === 'elseif') && ['for', 'if'].includes(scope.tag)) {
    // The else branch runs when the loop had no items, so its iteration names do not exist.
    scope.names.clear();
    scope.bindings.clear();
  } else if (tag === 'macro' || tag === 'block' || tag === 'with' || tag === 'embed') {
    if (tag === 'block' && tokens.length > 2) { return; }
    // A dynamic with-map could replace any key. Leave this scope unclaimed.
    const withAt = tag === 'with' ? 0 : tokens.findIndex((token) => token.value === 'with');
    const hasContext = withAt !== -1;
    const map = hasContext && tokens[withAt + 1] !== undefined && tokens[withAt + 1]?.value !== 'only'
      ? twigContextMap(tokens.slice(withAt + 1, tokens.at(-1)?.value === 'only' ? -1 : undefined)) : undefined;
    const nested = newScope(tag, tag === 'macro' || tokens.at(-1)?.value === 'only' || (map !== undefined && !map.complete));
    for (const key of map?.keys ?? []) {
      nested.names.add(key.name);
      nested.bindings.set(key.name, { ...key, kind: 'with' });
    }
    if (tag === 'macro') {
      for (const parameter of splitTwigTokens(tokens.slice(3, -1), ',')) {
        const token = parameter[0];
        if (token?.kind === 'name') {
          nested.names.add(token.value);
          nested.bindings.set(token.value, { name: token.value, kind: 'macro', range: { start: token.start, end: token.end } });
        }
      }
      nested.names.add('varargs');
      nested.bindings.set('varargs', { name: 'varargs', kind: 'macro', range: { start: tokens[0]!.start, end: tokens[0]!.end } });
    }
    scopes.push(tag === 'block' && tokens[1]?.kind === 'name' ? { ...nested, blockName: tokens[1].value } : nested);
  } else if (tag === 'do') {
    if (tokens[1]?.kind === 'name' && tokens[2]?.value === '=') { assign([tokens[1].value]); }
  } else if (tag === 'import' || tag === 'from') {
    const separator = tokens.findIndex((token) => token.value === (tag === 'import' ? 'as' : 'import'));
    assign(tokens.slice(separator + 1).filter((token, i, rest) => token.kind === 'name' &&
      token.value !== 'as' && rest[i + 1]?.value !== 'as').map((token) => token.value), 'import');
  }
}
