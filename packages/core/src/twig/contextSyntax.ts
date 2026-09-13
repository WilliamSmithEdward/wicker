import type { OffsetRange } from '../php/templateReferences.js';

import type { TwigExpressionToken as Token } from './expressionLexer.js';
import { readStringLiterals } from './twigLexer.js';

export interface ContextKey { readonly name: string; readonly range: OffsetRange }
export interface ContextMap { readonly keys: readonly ContextKey[]; readonly complete: boolean }

export function isTwigVariableName(name: string): boolean {
  return /^[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*$/.test(name) &&
    !['true', 'false', 'null', 'none', '_context', '_self', '_charset'].includes(name.toLowerCase());
}

export function literalTwigString(token: Token | undefined): string | undefined {
  if (token?.kind !== 'string' || !['"', "'"].includes(token.value[0] ?? '')) { return undefined; }
  return readStringLiterals(token.value, 0, token.value.length)[0]?.value;
}

/** Split only at the current nesting depth; map values and call arguments stay opaque. */
export function splitTwigTokens(tokens: readonly Token[], separator: string): readonly (readonly Token[])[] {
  const result: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'string' && token.value.startsWith('#')) { continue; }
    if (token.value === separator && depth === 0) { result.push([]); continue; }
    result.at(-1)?.push(token);
    if (['(', '[', '{'].includes(token.value)) { depth++; }
    else if ([')', ']', '}'].includes(token.value)) { depth--; }
  }
  return result;
}

/** Read literal keys, never keys nested in values or invented from a dynamic map. */
export function twigContextMap(tokens: readonly Token[]): ContextMap {
  if (tokens[0]?.value !== '{' || tokens.at(-1)?.value !== '}') { return { keys: [], complete: false }; }
  const keys: ContextKey[] = [];
  let complete = true;
  for (const entry of splitTwigTokens(tokens.slice(1, -1), ',')) {
    if (entry.length === 0) { continue; }
    const key = entry[0];
    const name = key?.kind === 'name' ? key.value : literalTwigString(key);
    if (key === undefined || name === undefined || entry[1]?.value !== ':' || entry.length < 3) {
      complete = false;
      continue;
    }
    if (isTwigVariableName(name)) {
      keys.push({ name, range: { start: key.start, end: key.end } });
    }
  }
  return { keys, complete };
}
