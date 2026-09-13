import type { OffsetRange } from '../php/templateReferences.js';

export interface TwigExpressionToken extends OffsetRange {
  readonly value: string;
  readonly kind: 'name' | 'string' | 'number' | 'punctuation';
}

const NAME = /^[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*$/;

/** Strings stay opaque, including interpolation, until their expressions can be parsed. */
export function tokenizeTwigExpression(source: string, start: number, end: number): TwigExpressionToken[] {
  const tokens: TwigExpressionToken[] = [];
  const pattern = /\s+|[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*|\d+(?:\.\d+)?|\?\.|=>|==|!=|<=|>=|\?\?|\.\.|\*\*|\/\/|./gy;
  const text = source.slice(0, end);
  let cursor = start;
  while (cursor < end) {
    const char = source[cursor];
    if (char === '#') {
      const from = cursor;
      const newline = source.indexOf('\n', cursor);
      cursor = newline === -1 ? end : Math.min(end, newline);
      tokens.push({ value: source.slice(from, cursor), start: from, end: cursor, kind: 'string' });
      continue;
    }
    if (char === "'" || char === '"') {
      const from = cursor++;
      while (cursor < end) {
        const current = source[cursor++];
        if (current === '\\') { cursor = Math.min(end, cursor + 1); }
        else if (current === char) { break; }
      }
      tokens.push({ value: source.slice(from, cursor), start: from, end: cursor, kind: 'string' });
      continue;
    }
    pattern.lastIndex = cursor;
    const match = pattern.exec(text);
    if (match === null) { break; }
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
