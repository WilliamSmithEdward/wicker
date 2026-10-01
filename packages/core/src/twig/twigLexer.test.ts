import { describe, expect, it } from 'vitest';

import { lexTwigRegions } from './twigLexer.js';

function inner(source: string): string[] {
  return lexTwigRegions(source)
    .filter((region) => region.kind !== 'text')
    .map((region) => source.slice(region.innerStart, region.innerEnd));
}

describe('lexTwigRegions', () => {
  it('leaves whitespace modifiers out of the content', () => {
    expect(inner('{%- if x -%}{{- y -}}{#- z -#}')).toEqual([' if x ', ' y ', ' z ']);
  });

  // Found by property testing: one `-` was taken as both the opening and the
  // closing modifier, so the content ended before it started.
  it.each(['{%-%}', '{{-}}', '{#-#}', '{%-', '{{-'])('gives %j empty content, never an inverted range', (source) => {
    for (const region of lexTwigRegions(source)) {
      expect(region.innerEnd).toBeGreaterThanOrEqual(region.innerStart);
    }
    expect(inner(source)).toEqual(['']);
  });

  it('runs an unterminated region to the end of the document', () => {
    const [region] = lexTwigRegions('{{ name');
    expect(region).toMatchObject({ kind: 'expression', start: 0, end: 7, innerStart: 2, innerEnd: 7 });
  });
});
