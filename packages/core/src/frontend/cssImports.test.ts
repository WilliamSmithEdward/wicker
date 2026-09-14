import { describe, expect, it } from 'vitest';

import { cssImports } from './cssImports.js';

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
