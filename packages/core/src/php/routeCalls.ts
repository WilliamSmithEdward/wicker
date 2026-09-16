import type { RouteCall } from '../frontend/references.js';
import { rememberLast } from '../util/rememberLast.js';
import { tokenizePhp, type PhpToken } from './lexer.js';
import type { OffsetRange } from './templateReferences.js';

/** A route call in PHP, with each literal key's own range for hover and navigation. */
export interface PhpRouteCall extends RouteCall {
  readonly parameters: readonly { readonly name: string; readonly range: OffsetRange }[];
}

/** The controller helpers that take a route name and its parameters, in that order. */
const HELPERS = new Set(['redirectToRoute', 'generateUrl']);

/**
 * `redirectToRoute()` and `generateUrl()` calls with a literal route name.
 *
 * Only a literal array says which keys it passes: a variable, a spread, a
 * computed key or an array joined to something else could hold anything, and
 * a call with no second argument passes nothing. The generic `generate()` is
 * left out, since a method of that name is not always the URL generator.
 */
export const phpRouteCalls = rememberLast(scan);

function scan(source: string): readonly PhpRouteCall[] {
  const calls: PhpRouteCall[] = [];
  if (source.length > 1_000_000) { return calls; }
  const tokens = tokenizePhp(source).filter((token) => token.kind !== 'comment');
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token.kind !== 'identifier' || !HELPERS.has(token.text) || tokens[at + 1]?.text !== '(') { continue; }
    const close = matching(tokens, at + 1, '(', ')');
    if (close === undefined) { break; }
    const [first, second] = splitTopLevel(tokens.slice(at + 2, close));
    const name = first?.[0];
    if (first?.length !== 1 || name?.kind !== 'string' || name.value === undefined) { at = close; continue; }
    const nameRange = { start: name.contentStart ?? name.start, end: name.contentEnd ?? name.end };
    calls.push({ name: name.value, nameRange, ...passed(second) });
    at = close;
  }
  return calls;
}

/** The keys a second argument passes, when it is a literal array whose every entry is a literal key. */
function passed(argument: readonly PhpToken[] | undefined): Pick<PhpRouteCall, 'keys' | 'arguments' | 'parameters'> {
  if (argument === undefined) { return { keys: [], parameters: [] }; }
  const open = argument[0];
  const close = open?.text === '[' ? matching(argument, 0, '[', ']') : undefined;
  if (open?.text !== '[' || close === undefined || close !== argument.length - 1) { return { parameters: [] }; }
  const parameters: { name: string; range: OffsetRange }[] = [];
  for (const entry of splitTopLevel(argument.slice(1, close))) {
    const key = entry[0];
    if (key?.kind === 'string' && key.value !== undefined && entry[1]?.text === '=>') {
      parameters.push({ name: key.value, range: { start: key.contentStart ?? key.start, end: key.contentEnd ?? key.end } });
    } else if (entry.length !== 1 || key?.kind !== 'string') {
      // A lone string is a key still being typed; anything else could hold any key.
      return { parameters: [] };
    }
  }
  return { keys: parameters.map((parameter) => parameter.name), parameters,
    arguments: { start: open.end, end: argument[close]!.start } };
}

function matching(tokens: readonly PhpToken[], at: number, open: string, close: string): number | undefined {
  let depth = 0;
  for (let index = at; index < tokens.length; index++) {
    const text = tokens[index]!.text;
    if (text === open) { depth++; }
    else if (text === close && --depth === 0) { return index; }
  }
  return undefined;
}

/** Splits on the commas at depth zero, dropping an empty trailing part. */
function splitTopLevel(tokens: readonly PhpToken[]): readonly (readonly PhpToken[])[] {
  const parts: PhpToken[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (['(', '[', '{'].includes(token.text)) { depth++; }
    else if ([')', ']', '}'].includes(token.text)) { depth--; }
    if (token.text === ',' && depth === 0) { parts.push([]); continue; }
    parts[parts.length - 1]!.push(token);
  }
  return parts.filter((part) => part.length > 0);
}
