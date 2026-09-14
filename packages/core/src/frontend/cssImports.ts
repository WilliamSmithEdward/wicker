/**
 * The stylesheets a stylesheet pulls in.
 *
 * A page's CSS is rarely one file. An entrypoint imports `app.css`, which
 * `@import`s the rest, and none of those names appear in any template. Without
 * following them, "which CSS does this page load" answers with the one file
 * that happens to be named out loud.
 *
 * Lexical, like the other readers here: comments and strings are skipped, and
 * only a literal specifier is reported. `@import url(var(--x))` names nothing
 * that can be resolved without running the browser.
 */

import type { OffsetRange } from '../php/templateReferences.js';

export interface CssImport {
  readonly specifier: string;
  readonly range: OffsetRange;
}

export function cssImports(source: string): readonly CssImport[] {
  const found: CssImport[] = [];
  // `@import` may be written as a bare string or wrapped in url(), and may be
  // followed by media queries or layer/supports conditions that are ignored.
  const statement = /@import\s+(?:url\(\s*)?(['"])([^'"\n]*)\1/g;
  const commentless = blankComments(source);

  let match: RegExpExecArray | null;
  while ((match = statement.exec(commentless)) !== null) {
    const specifier = match[2] ?? '';
    if (specifier.length === 0) { continue; }
    const start = match.index + match[0].length - specifier.length - 1;
    found.push({ specifier, range: { start, end: start + specifier.length } });
  }
  return found;
}

/**
 * Replaces comment bodies with spaces, keeping every offset intact so ranges
 * still point at the original text.
 */
function blankComments(source: string): string {
  const out = source.split('');
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] !== '/' || out[i + 1] !== '*') { continue; }
    const end = source.indexOf('*/', i + 2);
    const stop = end < 0 ? out.length : end + 2;
    for (let j = i; j < stop; j++) { if (out[j] !== '\n') { out[j] = ' '; } }
    i = stop - 1;
  }
  return out.join('');
}
