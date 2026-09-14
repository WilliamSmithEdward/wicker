/**
 * Reading `importmap.php`.
 *
 * The importmap is the table that turns a bare specifier in a JavaScript file
 * into a URL the browser can fetch. Nothing else in the project connects the
 * two: `import '#app/dates'` names a key here, and a key here names a file or
 * a package version. Without reading it, an import specifier is an opaque
 * string and a typo in one is invisible until the page loads.
 *
 * It is also the only way to alias a path. AssetMapper does not read Node's
 * `imports` field in `package.json`, and a directory prefix entry is rejected
 * because asset URLs carry a content hash and so have no stable prefix. An
 * alias is therefore one entry per file, which makes knowing which files have
 * one worth something.
 */

import { significantTokens, type PhpToken } from '../php/lexer.js';
import type { OffsetRange } from '../php/templateReferences.js';
import { normalizeProjectPath } from '../util/paths.js';

export interface ImportMapEntry {
  /** The bare specifier a JavaScript file imports, `#app/dates` or `react`. */
  readonly specifier: string;
  /** Where the specifier is written, for navigation back to the declaration. */
  readonly range: OffsetRange;
  /** Project-relative file, for a local entry. */
  readonly projectPath?: string;
  /** Declared version, for a package downloaded into the vendor directory. */
  readonly version?: string;
  /** True when a template may pass this specifier to `importmap()`. */
  readonly entrypoint: boolean;
}

/**
 * Entries from the array `importmap.php` returns.
 *
 * Deliberately literal. The file is ordinary PHP and may compute its contents,
 * but every entry Symfony's own tooling writes is a literal, and a key that
 * cannot be read as one is skipped rather than guessed at.
 */
export function parseImportMap(source: string): readonly ImportMapEntry[] {
  const tokens = significantTokens(source);
  const start = tokens.findIndex((token, index) =>
    token.text === 'return' && tokens[index + 1]?.text === '[');
  if (start < 0) {
    return [];
  }

  const entries: ImportMapEntry[] = [];
  const close = matching(tokens, start + 1);
  for (let i = start + 2; i < close; i++) {
    const key = tokens[i]!;
    if (key.kind !== 'string' || tokens[i + 1]?.text !== '=>' || key.value === undefined) {
      continue;
    }
    const open = i + 2;
    if (tokens[open]?.text !== '[') {
      // A form this parser does not model. Skipping it loses one entry rather
      // than mis-reading the rest of the file.
      i = open;
      continue;
    }
    const end = matching(tokens, open);
    entries.push({ ...settings(tokens, open, end), specifier: key.value, range: contentRange(key) });
    i = end;
  }
  return entries;
}

/** The `path`, `version` and `entrypoint` of one entry's inner array. */
function settings(tokens: readonly PhpToken[], open: number, close: number):
Pick<ImportMapEntry, 'projectPath' | 'version' | 'entrypoint'> {
  let projectPath: string | undefined;
  let version: string | undefined;
  let entrypoint = false;

  for (let i = open + 1; i < close; i++) {
    const key = tokens[i];
    if (key?.kind !== 'string' || tokens[i + 1]?.text !== '=>') { continue; }
    const value = tokens[i + 2];
    if (key.value === 'path' && value?.kind === 'string' && value.value !== undefined) {
      // Written relative to the project, conventionally with a leading "./".
      projectPath = normalizeProjectPath(value.value);
    } else if (key.value === 'version' && value?.kind === 'string') {
      version = value.value;
    } else if (key.value === 'entrypoint') {
      entrypoint = value?.text === 'true';
    }
    i += 2;
  }

  return { ...(projectPath !== undefined ? { projectPath } : {}), ...(version !== undefined ? { version } : {}), entrypoint };
}

/** Offsets of a string's contents, so navigation lands inside the quotes. */
function contentRange(token: PhpToken): OffsetRange {
  return { start: token.contentStart ?? token.start, end: token.contentEnd ?? token.end };
}

/** Index of the bracket closing the one at `open`, or the end of the tokens. */
function matching(tokens: readonly PhpToken[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const text = tokens[i]!.text;
    if (text === '[') { depth++; }
    else if (text === ']') { depth--; if (depth === 0) { return i; } }
  }
  return tokens.length;
}
