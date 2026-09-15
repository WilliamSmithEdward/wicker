import type { OffsetRange } from '../php/templateReferences.js';

export interface JsToken extends OffsetRange {
  readonly text: string;
  readonly kind: 'name' | 'string' | 'punctuation' | 'opaque';
  readonly value?: string;
}

/**
 * The last token stream, kept so indexing one file does not lex it repeatedly.
 *
 * A controller is lexed three times to be indexed once: the scan reads its
 * requests, the fetch-value sites are read from it again, and the Stimulus
 * declarations a third time. Each asks for the same source over the same
 * range, one after another, so one entry is all the reuse they need.
 *
 * The range is part of the key because a Twig template's scripts are lexed as
 * separate spans of one source, and answering with the wrong span would report
 * declarations from another `<script>` block entirely.
 */
let lastSource: string | undefined;
let lastStart = 0;
let lastEnd = 0;
let lastTokens: readonly JsToken[] | undefined;

const MAX_RETAINED_SOURCE = 512 * 1024;

/** A small lexical subset, not executable JS. Strings, comments and regex bodies
 * cannot introduce declarations. No runtime parser dependency is shipped. */
export function javascriptTokens(source: string, start = 0, end = source.length): readonly JsToken[] {
  if (lastTokens !== undefined && lastSource === source && lastStart === start && lastEnd === end) {
    return lastTokens;
  }
  const tokens = lexJavascript(source, start, end);
  if (source.length <= MAX_RETAINED_SOURCE) {
    lastSource = source;
    lastStart = start;
    lastEnd = end;
    lastTokens = tokens;
  }
  return tokens;
}

function lexJavascript(source: string, start: number, end: number): JsToken[] {
  const tokens: JsToken[] = [];
  let i = start;
  while (i < end) {
    const from = i;
    const char = source[i]!;
    if (/\s/.test(char)) { i++; continue; }
    if (source.startsWith('//', i)) { i = Math.min(end, source.indexOf('\n', i) < 0 ? end : source.indexOf('\n', i)); continue; }
    if (source.startsWith('/*', i)) { const close = source.indexOf('*/', i + 2); i = close < 0 ? end : Math.min(end, close + 2); continue; }
    if (['"', "'", '`'].includes(char)) {
      i++;
      let literal = true;
      while (i < end && source[i] !== char) {
        if (source[i] === '\\') { literal = false; i += 2; }
        else { if (char === '`' && source.startsWith('${', i)) { literal = false; } i++; }
      }
      const closed = source[i] === char;
      const value = source.slice(from + 1, Math.min(i, end));
      i = Math.min(end, i + (closed ? 1 : 0));
      tokens.push({ kind: literal ? 'string' : 'opaque', text: source.slice(from, i), start: from, end: i,
        ...(literal ? { value } : {}) });
      continue;
    }
    if (char === '/' && (!tokens.length || /^(?:[({[=,:;!?]|return|=>)$/.test(tokens.at(-1)!.text))) {
      i++;
      let bracket = false;
      while (i < end) {
        const next = source[i++];
        if (next === '\\') { i++; }
        else if (next === '[') { bracket = true; }
        else if (next === ']') { bracket = false; }
        else if (next === '/' && !bracket) { break; }
      }
      while (i < end && /[a-z]/i.test(source[i]!)) { i++; }
      tokens.push({ kind: 'opaque', text: source.slice(from, i), start: from, end: i });
      continue;
    }
    if (/[a-zA-Z_$]/.test(char)) {
      i++;
      while (i < end && /[\w$]/.test(source[i]!)) { i++; }
      tokens.push({ kind: 'name', text: source.slice(from, i), start: from, end: i });
    } else {
      const pair = source.slice(i, i + 2);
      i += ['=>', '?.', '==', '!=', '&&', '||', '??', '++', '--'].includes(pair) ? 2 : 1;
      tokens.push({ kind: 'punctuation', text: source.slice(from, i), start: from, end: i });
    }
  }
  return tokens;
}

/**
 * Bracket pairs, as a Map rather than an object literal.
 *
 * A plain object answers for every name on `Object.prototype`, so a token
 * reading `constructor`, `toString`, `valueOf` or `__proto__` came back
 * truthy and was pushed onto the stack as though it opened a bracket. The
 * matching then never balanced, and a Stimulus controller that declared a
 * constructor reported no targets, values or actions at all.
 *
 * Built once. This is the innermost loop of both parsers, and the table and
 * the closing list were being allocated again for every token scanned.
 */
const OPENERS = new Map([['(', ')'], ['[', ']'], ['#[', ']'], ['{', '}']]);
const CLOSERS = new Set([')', ']', '}']);

export function closingToken(tokens: readonly { text: string }[], at: number): number {
  const close = OPENERS.get(tokens[at]?.text ?? '');
  if (close === undefined) { return -1; }
  const stack = [close];
  for (let i = at + 1; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    const nested = OPENERS.get(text);
    if (nested !== undefined) { stack.push(nested); }
    else if (CLOSERS.has(text)) {
      if (stack.pop() !== text) { return -1; }
      if (stack.length === 0) { return i; }
    }
  }
  return -1;
}

export function stringRange(token: JsToken): OffsetRange {
  return { start: token.start + 1, end: token.end - (token.text.at(-1) === token.text[0] && token.text.length > 1 ? 1 : 0) };
}
