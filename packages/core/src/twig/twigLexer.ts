/**
 * A region-level lexer for Twig source.
 *
 * This is deliberately not a full Twig parser. It splits a document into the
 * four things Twig's own lexer distinguishes at the top level, which is enough
 * to find template references reliably and is the foundation a fuller parser
 * can be built on later.
 *
 * The reason it exists at all, rather than a pattern match over the raw text,
 * is that delimiters are not safe to match blindly: `{{ "why %} not" }}` is a
 * valid expression whose string contains a closing delimiter, and a `{# ... #}`
 * comment can contain anything at all, including unbalanced tags.
 */

export type TwigRegionKind = 'text' | 'comment' | 'statement' | 'expression';

export interface TwigRegion {
  readonly kind: TwigRegionKind;
  /** Offset of the opening delimiter, or of the text itself. */
  readonly start: number;
  /** Offset just past the closing delimiter. */
  readonly end: number;
  /** Offset of the content between the delimiters, whitespace modifiers excluded. */
  readonly innerStart: number;
  /** Offset just past that content. */
  readonly innerEnd: number;
}

const OPENERS: readonly { open: string; close: string; kind: TwigRegionKind }[] = [
  { open: '{#', close: '#}', kind: 'comment' },
  { open: '{%', close: '%}', kind: 'statement' },
  { open: '{{', close: '}}', kind: 'expression' },
];

/**
 * Splits Twig source into regions.
 *
 * An unterminated region at end of file is still reported, running to the end
 * of the document, because a user mid-keystroke has one constantly and the
 * features built on this must keep working while they type.
 */
export function lexTwigRegions(source: string): readonly TwigRegion[] {
  const regions: TwigRegion[] = [];
  let cursor = 0;
  let textStart = 0;

  while (cursor < source.length) {
    const opener = matchOpener(source, cursor);
    if (opener === undefined) {
      cursor += 1;
      continue;
    }

    if (cursor > textStart) {
      regions.push(textRegion(textStart, cursor));
    }

    const bodyStart = cursor + opener.open.length;
    const closeAt =
      opener.kind === 'comment'
        ? source.indexOf(opener.close, bodyStart)
        : findCloseOutsideStrings(source, bodyStart, opener.close);

    const terminated = closeAt !== -1;
    const end = terminated ? closeAt + opener.close.length : source.length;
    const bodyEnd = terminated ? closeAt : source.length;

    regions.push({
      kind: opener.kind,
      start: cursor,
      end,
      // `{%-` and `-%}` trim surrounding whitespace; the modifier is not content.
      innerStart: source.startsWith('-', bodyStart) ? bodyStart + 1 : bodyStart,
      innerEnd: bodyEnd > bodyStart && source[bodyEnd - 1] === '-' ? bodyEnd - 1 : bodyEnd,
    });

    cursor = end;
    textStart = end;
  }

  if (textStart < source.length) {
    regions.push(textRegion(textStart, source.length));
  }
  return regions;
}

function textRegion(start: number, end: number): TwigRegion {
  return { kind: 'text', start, end, innerStart: start, innerEnd: end };
}

function matchOpener(
  source: string,
  at: number,
): { open: string; close: string; kind: TwigRegionKind } | undefined {
  if (source[at] !== '{') {
    return undefined;
  }
  for (const opener of OPENERS) {
    if (source.startsWith(opener.open, at)) {
      return opener;
    }
  }
  return undefined;
}

/**
 * Finds a closing delimiter, skipping any that appear inside a string literal.
 *
 * Twig strings use single or double quotes with backslash escapes. Interpolated
 * `#{...}` sections inside double-quoted strings are treated as ordinary string
 * content here, which is correct for delimiter matching.
 */
function findCloseOutsideStrings(source: string, from: number, close: string): number {
  let cursor = from;
  let quote: string | undefined;

  while (cursor < source.length) {
    const char = source[cursor];

    if (quote !== undefined) {
      if (char === '\\') {
        cursor += 2;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      cursor += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      cursor += 1;
      continue;
    }

    if (source.startsWith(close, cursor)) {
      return cursor;
    }
    cursor += 1;
  }
  return -1;
}

export interface TwigStringLiteral {
  readonly value: string;
  /** Offsets of the contents, inside the quotes. */
  readonly start: number;
  readonly end: number;
}

/**
 * Reads every plain string literal in a span of Twig source.
 *
 * A double-quoted string containing `#{...}` interpolation is skipped, since
 * its value is not knowable statically and offering navigation from one would
 * be a guess.
 */
export function readStringLiterals(
  source: string,
  from: number,
  to: number,
): readonly TwigStringLiteral[] {
  const literals: TwigStringLiteral[] = [];
  let cursor = from;

  while (cursor < to) {
    const char = source[cursor];
    if (char !== "'" && char !== '"') {
      cursor += 1;
      continue;
    }

    const quote = char;
    const contentStart = cursor + 1;
    let scan = contentStart;
    let value = '';
    let interpolated = false;
    let terminated = false;

    while (scan < to) {
      const current = source[scan];
      if (current === '\\' && scan + 1 < to) {
        value += unescape(source[scan + 1] ?? '');
        scan += 2;
        continue;
      }
      if (current === quote) {
        terminated = true;
        break;
      }
      if (quote === '"' && current === '#' && source[scan + 1] === '{') {
        interpolated = true;
      }
      value += current;
      scan += 1;
    }

    if (terminated && !interpolated) {
      literals.push({ value, start: contentStart, end: scan });
    }
    cursor = terminated ? scan + 1 : to;
  }

  return literals;
}

/** Twig's escape sequences inside a string literal. */
function unescape(character: string): string {
  switch (character) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    case '\\':
      return '\\';
    case "'":
      return "'";
    case '"':
      return '"';
    default:
      return character;
  }
}
