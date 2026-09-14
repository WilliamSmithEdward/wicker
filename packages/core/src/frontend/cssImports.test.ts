import { describe, expect, it } from 'vitest';

import { cssImports, cssUrls } from './cssImports.js';

describe('cssImports', () => {
  it('reads both spellings, with and without url()', () => {
    const source = `@import 'reset.css';\n@import url("theme.css");`;
    expect(cssImports(source).map((entry) => entry.specifier)).toEqual(['reset.css', 'theme.css']);
    for (const entry of cssImports(source)) {
      expect(source.slice(entry.range.start, entry.range.end)).toBe(entry.specifier);
    }
  });

  it('ignores media queries and layer conditions that follow', () => {
    expect(cssImports(`@import 'print.css' print;`).map((entry) => entry.specifier)).toEqual(['print.css']);
    expect(cssImports(`@import url('a.css') layer(base);`).map((entry) => entry.specifier)).toEqual(['a.css']);
  });

  it('reads nothing from a commented-out import', () => {
    expect(cssImports(`/* @import 'old.css'; */\n@import 'new.css';`).map((entry) => entry.specifier))
      .toEqual(['new.css']);
  });

  it('keeps offsets correct after a comment, so ranges still point at the text', () => {
    const source = `/* a note */\n@import 'after.css';`;
    const [found] = cssImports(source);
    expect(source.slice(found!.range.start, found!.range.end)).toBe('after.css');
  });

  it('claims nothing for a specifier it cannot read literally', () => {
    expect(cssImports('@import url(var(--sheet));')).toEqual([]);
    expect(cssImports('body { color: red; }')).toEqual([]);
  });
});

describe('cssUrls', () => {
  it('reads quoted and unquoted references', () => {
    const source = `a { background: url('logo.png'); }\nb { src: url(../fonts/x.woff2); }`;
    expect(cssUrls(source).map((entry) => entry.specifier)).toEqual(['logo.png', '../fonts/x.woff2']);
    for (const entry of cssUrls(source)) {
      expect(source.slice(entry.range.start, entry.range.end)).toBe(entry.specifier);
    }
  });

  it('keeps a fragment or query, which addresses part of the same file', () => {
    expect(cssUrls(`a { background: url('icons.svg#pin'); }`).map((e) => e.specifier)).toEqual(['icons.svg#pin']);
    expect(cssUrls(`a { src: url('f.woff2?v=2'); }`).map((e) => e.specifier)).toEqual(['f.woff2?v=2']);
  });

  it('skips references that name no project file', () => {
    expect(cssUrls(`a { background: url(data:image/png;base64,AAA); }`)).toEqual([]);
    expect(cssUrls(`a { background: url(https://example.test/x.png); }`)).toEqual([]);
    expect(cssUrls(`a { background: url(//cdn.test/x.png); }`)).toEqual([]);
    expect(cssUrls(`a { background: url(var(--icon)); }`)).toEqual([]);
  });

  it('ignores a commented-out reference', () => {
    expect(cssUrls(`/* url('old.png') */ a { background: url('new.png'); }`).map((e) => e.specifier))
      .toEqual(['new.png']);
  });
});
