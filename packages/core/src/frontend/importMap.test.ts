import { describe, expect, it } from 'vitest';

import { parseImportMap } from './importMap.js';

/** The shape Symfony's own tooling writes, trimmed from the live application. */
const SOURCE = `<?php

/**
 * Returns the importmap for this application.
 */
return [
    'app' => ['path' => './assets/app.js', 'entrypoint' => true],
    '#app/dates' => ['path' => './assets/utils/dates.js'],
    '@hotwired/stimulus' => ['version' => '3.2.2'],
    '@symfony/stimulus-bundle' => ['path' => './vendor/symfony/stimulus-bundle/assets/dist/loader.js'],
    'shiki/core' => ['version' => '4.4.3'],
];
`;

describe('parseImportMap', () => {
  const entries = parseImportMap(SOURCE);

  it('reads every specifier in declaration order', () => {
    expect(entries.map((entry) => entry.specifier)).toEqual([
      'app', '#app/dates', '@hotwired/stimulus', '@symfony/stimulus-bundle', 'shiki/core',
    ]);
  });

  it('resolves a local path to a project-relative file', () => {
    expect(entries[1]).toMatchObject({ specifier: '#app/dates', projectPath: 'assets/utils/dates.js' });
    expect(entries[3]?.projectPath).toBe('vendor/symfony/stimulus-bundle/assets/dist/loader.js');
  });

  it('keeps a downloaded package as a version rather than inventing a path', () => {
    expect(entries[2]).toMatchObject({ specifier: '@hotwired/stimulus', version: '3.2.2' });
    expect(entries[2]?.projectPath).toBeUndefined();
  });

  it('marks only the declared entrypoints', () => {
    expect(entries.filter((entry) => entry.entrypoint).map((entry) => entry.specifier)).toEqual(['app']);
  });

  it('points at the specifier inside its quotes', () => {
    for (const entry of entries) {
      expect(SOURCE.slice(entry.range.start, entry.range.end)).toBe(entry.specifier);
    }
  });

  it('ignores the docblock rather than reading a specifier out of it', () => {
    expect(entries.some((entry) => entry.specifier.includes('importmap for'))).toBe(false);
  });

  it('reads nothing from a file that returns no array', () => {
    expect(parseImportMap('<?php // nothing here')).toEqual([]);
    expect(parseImportMap('')).toEqual([]);
  });

  it('skips an entry it cannot read literally and keeps the rest', () => {
    // The file is ordinary PHP and may compute an entry. Losing one is better
    // than mis-reading the entries around it.
    const computed = `<?php return [
      'app' => ['path' => './assets/app.js'],
      'generated' => $dynamic,
      'react' => ['version' => '19.3.0'],
    ];`;
    expect(parseImportMap(computed).map((entry) => entry.specifier)).toEqual(['app', 'react']);
  });
});
