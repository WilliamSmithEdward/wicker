/**
 * A small YAML reader, covering the subset Symfony configuration uses.
 *
 * Wicker ships no third-party code, so this exists rather than a dependency.
 * It is deliberately not a general YAML implementation: it reads block
 * mappings and sequences, the three scalar styles, flow sequences, comments,
 * and the null spellings, which is what `config/packages/*.yaml` is made of.
 *
 * What it does not do, and does not pretend to: anchors and aliases, tags,
 * multi-document streams, block scalars, complex keys, and flow mappings.
 * Anything it cannot read becomes undefined rather than a guess, and every
 * caller already treats an unreadable config as "nothing configured".
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  readonly indent: number;
  readonly content: string;
}

/**
 * Parses a YAML document. Returns undefined when the text is not a mapping or
 * sequence this reader understands.
 */
export function parseYaml(source: string): YamlValue | undefined {
  const lines = readLines(source);
  if (lines.length === 0) {
    return undefined;
  }

  const cursor = { index: 0 };
  const firstIndent = lines[0]?.indent ?? 0;
  const value = parseBlock(lines, cursor, firstIndent);
  return cursor.index === 0 ? undefined : value;
}

/** Strips comments and blank lines, recording each line's indentation. */
function readLines(source: string): Line[] {
  const lines: Line[] = [];

  for (const raw of source.split(/\r?\n/)) {
    const withoutComment = stripComment(raw);
    const content = withoutComment.trimEnd();
    if (content.trim().length === 0) {
      continue;
    }
    lines.push({
      indent: content.length - content.trimStart().length,
      content: content.trim(),
    });
  }
  return lines;
}

/**
 * Removes a trailing comment.
 *
 * A `#` only starts a comment at the beginning of a line or after whitespace,
 * so a value such as `'%kernel.project_dir%/a#b'` keeps its hash, and a hash
 * inside quotes is left alone.
 */
function stripComment(line: string): string {
  let quote: string | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (char === '\\' && quote === '"') {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1] ?? ''))) {
      return line.slice(0, index);
    }
  }
  return line;
}

interface Cursor {
  index: number;
}

/** Parses the block of lines at or below the given indentation. */
function parseBlock(lines: readonly Line[], cursor: Cursor, indent: number): YamlValue {
  const first = lines[cursor.index];
  if (first === undefined) {
    return null;
  }
  return first.content.startsWith('- ') || first.content === '-'
    ? parseSequence(lines, cursor, indent)
    : parseMapping(lines, cursor, indent);
}

function parseMapping(
  lines: readonly Line[],
  cursor: Cursor,
  indent: number,
): Record<string, YamlValue> {
  const result: Record<string, YamlValue> = {};

  while (cursor.index < lines.length) {
    const line = lines[cursor.index];
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      // Deeper than expected without a parent key; skip rather than guess.
      cursor.index += 1;
      continue;
    }

    const split = splitKey(line.content);
    if (split === undefined) {
      cursor.index += 1;
      continue;
    }

    cursor.index += 1;
    const { key, rest } = split;

    if (rest.length > 0) {
      result[key] = parseScalar(rest);
      continue;
    }

    // No inline value: the value is the nested block, if one follows.
    const next = lines[cursor.index];
    result[key] = next !== undefined && next.indent > indent ? parseBlock(lines, cursor, next.indent) : null;
  }

  return result;
}

function parseSequence(lines: readonly Line[], cursor: Cursor, indent: number): YamlValue[] {
  const result: YamlValue[] = [];

  while (cursor.index < lines.length) {
    const line = lines[cursor.index];
    if (line === undefined || line.indent < indent || !line.content.startsWith('-')) {
      break;
    }

    const rest = line.content === '-' ? '' : line.content.slice(1).trimStart();
    cursor.index += 1;

    if (rest.length > 0) {
      const entry = splitKey(rest);
      if (entry === undefined) {
        result.push(parseScalar(rest));
        continue;
      }

      // The compact form, `- key: value`, where the item is a mapping whose
      // first pair sits on the dash line and whose siblings line up under it.
      const keyColumn = line.indent + (line.content.length - rest.length);
      const item: Record<string, YamlValue> = {};

      if (entry.rest.length > 0) {
        item[entry.key] = parseScalar(entry.rest);
      } else {
        const nested = lines[cursor.index];
        item[entry.key] =
          nested !== undefined && nested.indent > keyColumn
            ? parseBlock(lines, cursor, nested.indent)
            : null;
      }

      Object.assign(item, parseMapping(lines, cursor, keyColumn));
      result.push(item);
      continue;
    }

    const next = lines[cursor.index];
    result.push(next !== undefined && next.indent > indent ? parseBlock(lines, cursor, next.indent) : null);
  }

  return result;
}

/**
 * Splits `key: value`, honouring quoted keys.
 *
 * Symfony writes paths as keys, and those contain colons on Windows and
 * percent signs everywhere, so the separator has to be found outside quotes.
 */
function splitKey(content: string): { key: string; rest: string } | undefined {
  let quote: string | undefined;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote !== undefined) {
      if (char === '\\' && quote === '"') {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    // A colon separates only when followed by whitespace or end of line.
    if (char === ':' && (index + 1 >= content.length || /\s/.test(content[index + 1] ?? ''))) {
      return {
        key: unquote(content.slice(0, index).trim()),
        rest: content.slice(index + 1).trim(),
      };
    }
  }
  return undefined;
}

function parseScalar(raw: string): YamlValue {
  const value = raw.trim();

  if (value.startsWith('[')) {
    return parseFlowSequence(value);
  }
  if (value.startsWith("'") || value.startsWith('"')) {
    return unquote(value);
  }

  switch (value) {
    case '~':
    case 'null':
    case 'Null':
    case 'NULL':
    case '':
      return null;
    case 'true':
    case 'True':
    case 'TRUE':
      return true;
    case 'false':
    case 'False':
    case 'FALSE':
      return false;
    default:
      break;
  }

  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (/^-?\d*\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }
  return value;
}

/** Reads `[a, 'b', c]`, splitting only at top level and outside quotes. */
function parseFlowSequence(raw: string): YamlValue[] {
  const inner = raw.slice(1, raw.endsWith(']') ? -1 : undefined);
  const items: YamlValue[] = [];

  let depth = 0;
  let quote: string | undefined;
  let start = 0;

  const push = (end: number): void => {
    const piece = inner.slice(start, end).trim();
    if (piece.length > 0) {
      items.push(parseScalar(piece));
    }
    start = end + 1;
  };

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (quote !== undefined) {
      if (char === '\\' && quote === '"') {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      push(index);
    }
  }
  push(inner.length);

  return items;
}

/** Removes surrounding quotes and applies the escaping rules of each style. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    // Single quotes are literal; only a doubled quote is an escape.
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, (_match, char: string) => {
      switch (char) {
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'r':
          return '\r';
        default:
          return char;
      }
    });
  }
  return value;
}
