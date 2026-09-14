import type { OffsetRange } from '../php/templateReferences.js';
import { closingToken, javascriptTokens, stringRange, type JsToken } from './javascript.js';
import { scanFrontend, type FrontendReference } from './references.js';

export interface ResponseAccess {
  readonly name: string;
  readonly range: OffsetRange;
  readonly path: readonly string[];
  readonly endpoint: FrontendReference | { readonly kind: 'stimulus-value'; readonly name: string; readonly range: OffsetRange };
}
type Endpoint = ResponseAccess['endpoint'];

/** Follows local, awaited fetch/json assignments. No execution, speculative
 * serializer schemas or cross-function data-flow inference. */
export function responseAccessAt(source: string, offset: number, twig: boolean): ResponseAccess | undefined {
  const scan = scanFrontend(source, twig);
  const script = scan.scripts.find((range) => offset >= range.start && offset <= range.end);
  if (!script) { return undefined; }
  const tokens = javascriptTokens(source, script.start, script.end);
  let at = tokens.findIndex((token) => token.start < offset && token.end >= offset);
  if (at < 0) { for (let i = 0; i < tokens.length && tokens[i]!.end <= offset; i++) { at = i; } }
  const current = tokens[at];
  if (!current) { return undefined; }
  let name = '', range = { start: offset, end: offset }, dot = at;
  if (current.kind === 'name') { name = current.text; range = current; dot--; }
  else if (!['.', '?.'].includes(current.text) || current.end > offset) { return undefined; }
  if (!['.', '?.'].includes(tokens[dot]?.text ?? '')) { return undefined; }
  const path: string[] = [];
  let base = dot - 1;
  while (base >= 0) {
    if (tokens[base]?.text === ']' && tokens[base - 2]?.text === '[' && /^\d$/.test(tokens[base - 1]?.text ?? '')) {
      path.unshift('[]'); base -= 3; continue;
    }
    if (tokens[base]?.kind !== 'name') { return undefined; }
    if (['.', '?.'].includes(tokens[base - 1]?.text ?? '')) { path.unshift(tokens[base]!.text); base -= 2; }
    else { break; }
  }
  const variable = tokens[base]?.text;
  if (!variable || variable === 'this') { return undefined; }
  // The innermost block is a conservative scope boundary. This avoids leaking
  // a same-named variable out of a sibling function or control-flow branch.
  let scope = 0;
  for (let i = 0; i < base; i++) {
    if (tokens[i]!.text === '{' && closingToken(tokens, i) >= base) { scope = i + 1; }
  }
  const responses = new Map<string, Endpoint>(), data = new Map<string, Endpoint>();
  for (let i = scope; i < base; i++) {
    const token = tokens[i]!;
    if (token.text === '{') { const end = closingToken(tokens, i); if (end >= 0 && end < base) { i = end; continue; } }
    if (token.kind !== 'name' || tokens[i + 1]?.text !== '=' || ['.', '?.'].includes(tokens[i - 1]?.text ?? '')) { continue; }
    responses.delete(token.text); data.delete(token.text);
    let rhs = i + 2;
    if (tokens[rhs]?.text !== 'await') { continue; }
    rhs++;
    if (tokens[rhs]?.text === 'fetch' && tokens[rhs + 1]?.text === '(') {
      const endpoint = fetchEndpoint(tokens, rhs + 2, scan.references);
      if (endpoint) { responses.set(token.text, endpoint); }
    } else if (tokens[rhs]?.kind === 'name' && tokens[rhs + 1]?.text === '.' && tokens[rhs + 2]?.text === 'json' &&
      tokens[rhs + 3]?.text === '(' && tokens[rhs + 4]?.text === ')') {
      const endpoint = responses.get(tokens[rhs]!.text);
      if (endpoint) { data.set(token.text, endpoint); }
    }
  }
  const endpoint = data.get(variable);
  return endpoint ? { name, range, path, endpoint } : undefined;
}

function fetchEndpoint(tokens: readonly JsToken[], at: number, references: readonly FrontendReference[]): Endpoint | undefined {
  const arg = tokens[at];
  if (arg?.kind === 'string' && [')', ','].includes(tokens[at + 1]?.text ?? '')) {
    const embedded = references.filter((ref) => ref.kind === 'route' && ref.range.start > arg.start && ref.range.end < arg.end);
    if (embedded.length === 1 && /^\{\{\s*(?:path|url)\([\s\S]*\)\s*\}\}$/.test(arg.value ?? '')) { return embedded[0]; }
    if (arg.value?.startsWith('/') && !arg.value.startsWith('//')) { return { kind: 'url', name: arg.value, range: stringRange(arg) }; }
  }
  if (arg?.text === 'this' && tokens[at + 1]?.text === '.' && tokens[at + 2]?.text.endsWith('Value') &&
    [')', ','].includes(tokens[at + 3]?.text ?? '')) {
    return { kind: 'stimulus-value', name: tokens[at + 2]!.text.slice(0, -5), range: tokens[at + 2]! };
  }
  return undefined;
}
