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
  // Assembled from slices rather than one string per character. Newlines
  // survive so a range still reports the line it came from, and an unterminated
  // comment runs to the end of the file, which is what a browser does with it.
  if (!source.includes('/*')) { return source; }
  const pieces: string[] = [];
  let at = 0;
  for (const comment of source.matchAll(/\/\*[\s\S]*?(?:\*\/|$)/g)) {
    pieces.push(source.slice(at, comment.index), comment[0].replace(/[^\n]/g, ' '));
    at = comment.index + comment[0].length;
  }
  pieces.push(source.slice(at));
  return pieces.join('');
}

/**
 * The files a stylesheet references through `url()`.
 *
 * AssetMapper rewrites these to hashed URLs when it serves the sheet, so a
 * path that resolves to nothing is a broken image or font with no error
 * anywhere. They are resolved relative to the stylesheet, like an import.
 *
 * Data URIs and absolute URLs name no project file and are skipped, as is a
 * computed value such as `url(var(--icon))`.
 */
export function cssUrls(source: string): readonly CssImport[] {
  const found: CssImport[] = [];
  const commentless = blankComments(source);
  const statement = /\burl\(\s*(['"]?)([^'")\n]*)\1\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = statement.exec(commentless)) !== null) {
    const specifier = (match[2] ?? '').trim();
    // A bracket means the value is a function call such as var(--icon), which
    // names nothing until the browser resolves it.
    if (specifier.length === 0 || specifier.includes('(') ||
      /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(specifier)) { continue; }
    const start = commentless.indexOf(specifier, match.index);
    found.push({ specifier, range: { start, end: start + specifier.length } });
  }
  return found;
}
