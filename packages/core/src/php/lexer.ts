/**
 * A PHP tokenizer.
 *
 * Wicker ships no third-party code, so this replaces the PHP parser the
 * engine used to depend on. It is written as a general lexer rather than a
 * pattern match for today's feature, because the same token stream is what
 * broader PHP support will be built on.
 *
 * Every token carries its exact offsets. That is the whole point: the editor
 * needs to underline a template name inside its quotes, not the statement
 * around it.
 */

import { rememberLast } from '../util/rememberLast.js';

export type PhpTokenKind =
  /** Text outside `<?php ... ?>`. */
  | 'inline-html'
  | 'open-tag'
  | 'close-tag'
  | 'comment'
  | 'variable'
  | 'identifier'
  | 'number'
  /** A string whose value is known: single-quoted, or double-quoted with no interpolation. */
  | 'string'
  /** A string containing interpolation, whose value is not statically known. */
  | 'interpolated-string'
  /** `#[`, which opens an attribute rather than a comment. */
  | 'attribute-open'
  | 'operator'
  | 'punctuation'
  | 'unknown';

export interface PhpToken {
  readonly kind: PhpTokenKind;
  /** Offset of the first character. */
  readonly start: number;
  /** Offset just past the last character. */
  readonly end: number;
  /** Source text of the token, verbatim. */
  readonly text: string;
  /**
   * For a `string` token, the decoded value. Offsets of the contents, inside
   * the quotes, are `contentStart` and `contentEnd`.
   */
  readonly value?: string;
  readonly contentStart?: number;
  readonly contentEnd?: number;
}

/** Multi-character operators, longest first so the longest match wins. */
const OPERATORS: readonly string[] = [
  '<<<',
  '<=>',
  '===',
  '!==',
  '**=',
  '...',
  '<<=',
  '>>=',
  '??=',
  '?->',
  '||=',
  '&&=',
  '==',
  '!=',
  '<>',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '->',
  '=>',
  '::',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '.=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>',
  '**',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '!',
  '.',
  '?',
  ':',
  '&',
  '|',
  '^',
  '~',
  '@',
];

const PUNCTUATION = new Set(['(', ')', '[', ']', '{', '}', ',', ';', '\\']);

/**
 * Tokenizes PHP source. Never throws: anything unrecognised becomes an
 * `unknown` token so a file being typed still yields a usable stream.
 */
export function tokenizePhp(source: string): readonly PhpToken[] {
  const tokens: PhpToken[] = [];
  let cursor = 0;
  let inPhp = false;

  const push = (token: PhpToken): void => {
    tokens.push(token);
    cursor = token.end;
  };

  while (cursor < source.length) {
    if (!inPhp) {
      const openAt = source.indexOf('<?php', cursor);
      const shortAt = source.indexOf('<?=', cursor);
      const at = pickFirst(openAt, shortAt);

      if (at === -1) {
        push({ kind: 'inline-html', start: cursor, end: source.length, text: source.slice(cursor) });
        break;
      }
      if (at > cursor) {
        push({ kind: 'inline-html', start: cursor, end: at, text: source.slice(cursor, at) });
      }
      const length = source.startsWith('<?php', at) ? 5 : 3;
      push({ kind: 'open-tag', start: at, end: at + length, text: source.slice(at, at + length) });
      inPhp = true;
      continue;
    }

    const char = source[cursor];
    if (char === undefined) {
      break;
    }

    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }

    if (source.startsWith('?>', cursor)) {
      push({ kind: 'close-tag', start: cursor, end: cursor + 2, text: '?>' });
      inPhp = false;
      continue;
    }

    // `#[` opens an attribute; a lone `#` starts a comment. Checked in this
    // order because the attribute form would otherwise be read as a comment
    // and every #[Route] and #[Template] would vanish.
    if (source.startsWith('#[', cursor)) {
      push({ kind: 'attribute-open', start: cursor, end: cursor + 2, text: '#[' });
      continue;
    }

    if (char === '#' || source.startsWith('//', cursor)) {
      push(readLineComment(source, cursor));
      continue;
    }

    if (source.startsWith('/*', cursor)) {
      push(readBlockComment(source, cursor));
      continue;
    }

    if (char === '$') {
      push(readVariable(source, cursor));
      continue;
    }

    if (char === "'") {
      push(readSingleQuoted(source, cursor));
      continue;
    }

    if (char === '"') {
      push(readDoubleQuoted(source, cursor));
      continue;
    }

    if (source.startsWith('<<<', cursor)) {
      const heredoc = readHeredoc(source, cursor);
      if (heredoc !== undefined) {
        push(heredoc);
        continue;
      }
    }

    if (/[0-9]/.test(char)) {
      push(readNumber(source, cursor));
      continue;
    }

    if (/[A-Za-z_\x80-￿]/.test(char)) {
      push(readIdentifier(source, cursor));
      continue;
    }

    if (PUNCTUATION.has(char)) {
      push({ kind: 'punctuation', start: cursor, end: cursor + 1, text: char });
      continue;
    }

    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, cursor));
    if (operator !== undefined) {
      push({ kind: 'operator', start: cursor, end: cursor + operator.length, text: operator });
      continue;
    }

    push({ kind: 'unknown', start: cursor, end: cursor + 1, text: char });
  }

  return tokens;
}

function pickFirst(a: number, b: number): number {
  if (a === -1) {
    return b;
  }
  if (b === -1) {
    return a;
  }
  return Math.min(a, b);
}

function readLineComment(source: string, start: number): PhpToken {
  // A line comment ends at a newline or at `?>`, which closes PHP even from
  // inside one.
  let end = start;
  while (end < source.length && source[end] !== '\n' && !source.startsWith('?>', end)) {
    end += 1;
  }
  return { kind: 'comment', start, end, text: source.slice(start, end) };
}

function readBlockComment(source: string, start: number): PhpToken {
  const closeAt = source.indexOf('*/', start + 2);
  const end = closeAt === -1 ? source.length : closeAt + 2;
  return { kind: 'comment', start, end, text: source.slice(start, end) };
}

function readVariable(source: string, start: number): PhpToken {
  let end = start + 1;
  while (end < source.length && /[A-Za-z0-9_\x80-￿]/.test(source[end] ?? '')) {
    end += 1;
  }
  return { kind: 'variable', start, end, text: source.slice(start, end) };
}

function readIdentifier(source: string, start: number): PhpToken {
  let end = start;
  while (end < source.length && /[A-Za-z0-9_\x80-￿]/.test(source[end] ?? '')) {
    end += 1;
  }
  return { kind: 'identifier', start, end, text: source.slice(start, end) };
}

function readNumber(source: string, start: number): PhpToken {
  let end = start;
  while (end < source.length && /[0-9a-fA-FxXbBoO._]/.test(source[end] ?? '')) {
    end += 1;
  }
  return { kind: 'number', start, end, text: source.slice(start, end) };
}

/** Single quotes: only `\'` and `\\` are escapes, everything else is literal. */
function readSingleQuoted(source: string, start: number): PhpToken {
  let cursor = start + 1;
  let value = '';

  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      const next = source[cursor + 1];
      if (next === "'" || next === '\\') {
        value += next;
        cursor += 2;
        continue;
      }
      value += char;
      cursor += 1;
      continue;
    }
    if (char === "'") {
      return {
        kind: 'string',
        start,
        end: cursor + 1,
        text: source.slice(start, cursor + 1),
        value,
        contentStart: start + 1,
        contentEnd: cursor,
      };
    }
    value += char;
    cursor += 1;
  }

  // Unterminated, which happens constantly while typing.
  return {
    kind: 'string',
    start,
    end: source.length,
    text: source.slice(start),
    value,
    contentStart: start + 1,
    contentEnd: source.length,
  };
}

/**
 * Double quotes, which interpolate. A string containing `$name` or `{$expr}`
 * has no statically known value and is reported as interpolated so callers
 * skip it rather than navigating somewhere wrong.
 */
function readDoubleQuoted(source: string, start: number): PhpToken {
  let cursor = start + 1;
  let value = '';
  let interpolated = false;

  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      const next = source[cursor + 1] ?? '';
      value += decodeEscape(next);
      cursor += 2;
      continue;
    }
    if (char === '"') {
      return {
        kind: interpolated ? 'interpolated-string' : 'string',
        start,
        end: cursor + 1,
        text: source.slice(start, cursor + 1),
        value,
        contentStart: start + 1,
        contentEnd: cursor,
      };
    }
    if (char === '$' && /[A-Za-z_{]/.test(source[cursor + 1] ?? '')) {
      interpolated = true;
    }
    if (char === '{' && source[cursor + 1] === '$') {
      interpolated = true;
    }
    value += char;
    cursor += 1;
  }

  return {
    kind: interpolated ? 'interpolated-string' : 'string',
    start,
    end: source.length,
    text: source.slice(start),
    value,
    contentStart: start + 1,
    contentEnd: source.length,
  };
}

function decodeEscape(char: string): string {
  switch (char) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    case 'v':
      return '\v';
    case 'f':
      return '\f';
    case 'e':
      return '\x1b';
    case '0':
      return '\0';
    default:
      // Covers \\ \" \$ and, per PHP, any other character stands for itself.
      return char;
  }
}

/**
 * Heredoc and nowdoc.
 *
 * Nowdoc, with a single-quoted label, does not interpolate. Heredoc does, and
 * is treated like a double-quoted string. The closing label may be indented
 * since PHP 7.3, and that indentation is stripped from the body.
 */
function readHeredoc(source: string, start: number): PhpToken | undefined {
  const header = /^<<<[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\r?\n/.exec(
    source.slice(start),
  );
  if (header === null) {
    return undefined;
  }

  const nowdocLabel = header[1];
  const label = nowdocLabel ?? header[2] ?? header[3];
  if (label === undefined) {
    return undefined;
  }

  const bodyStart = start + header[0].length;
  const closer = new RegExp(`^[ \\t]*${label}\\b`, 'm');
  const match = closer.exec(source.slice(bodyStart));

  if (match === null) {
    return {
      kind: 'string',
      start,
      end: source.length,
      text: source.slice(start),
      value: source.slice(bodyStart),
      contentStart: bodyStart,
      contentEnd: source.length,
    };
  }

  const bodyEnd = bodyStart + match.index;
  const indent = (/^[ \t]*/.exec(match[0]) ?? [''])[0].length;
  // The body keeps a trailing newline before the closer; drop it.
  const rawBody = source.slice(bodyStart, bodyEnd).replace(/\r?\n$/, '');
  const body =
    indent === 0
      ? rawBody
      : rawBody
          .split('\n')
          .map((line) => (line.startsWith(' '.repeat(indent)) || line.startsWith('\t'.repeat(indent)) ? line.slice(indent) : line))
          .join('\n');

  const interpolated = nowdocLabel === undefined && /\$[A-Za-z_{]|\{\$/.test(rawBody);

  return {
    kind: interpolated ? 'interpolated-string' : 'string',
    start,
    end: bodyStart + match.index + match[0].length,
    text: source.slice(start, bodyStart + match.index + match[0].length),
    value: body,
    contentStart: bodyStart,
    contentEnd: bodyEnd,
  };
}

/** Tokens that carry no meaning for a parser walking the stream. */
export function isTrivia(token: PhpToken): boolean {
  return token.kind === 'comment' || token.kind === 'inline-html';
}

/**
 * The token stream with comments and inline HTML removed.
 *
 * Remembered, because indexing one PHP file asks for this four times over: the
 * route actions are read from it, the templates those actions render are read
 * from it again, the type declarations after that, and the render sites once
 * more, each with the same source one after another.
 */
export const significantTokens = rememberLast(
  (source: string): readonly PhpToken[] => tokenizePhp(source).filter((token) => !isTrivia(token)),
);
