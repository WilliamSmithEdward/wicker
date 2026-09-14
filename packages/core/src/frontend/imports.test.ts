import { describe, expect, it } from 'vitest';

import { importSpecifiers, resolveRelativeImport } from './imports.js';

describe('importSpecifiers', () => {
  const source = `import { Controller } from '@hotwired/stimulus';
import format from '#app/dates';
import './side-effect.js';
import * as everything from '../shared/util.js';
export { helper } from './helpers.js';
const lazy = await import('#app/heavy');
const url = import.meta.url;
const computed = await import(base + '/thing.js');
const text = "import 'not-an-import.js'";`;

  const found = importSpecifiers(source);

  it('reads every literal form', () => {
    expect(found.map((entry) => entry.specifier)).toEqual([
      '@hotwired/stimulus', '#app/dates', './side-effect.js',
      '../shared/util.js', './helpers.js', '#app/heavy',
    ]);
  });

  it('points inside the quotes', () => {
    for (const entry of found) {
      expect(source.slice(entry.range.start, entry.range.end)).toBe(entry.specifier);
    }
  });

  it('marks the dynamic form, which the browser resolves the same way', () => {
    expect(found.filter((entry) => entry.dynamic).map((entry) => entry.specifier)).toEqual(['#app/heavy']);
  });

  it('reads neither import.meta nor a computed specifier nor a string that looks like one', () => {
    expect(found.some((entry) => entry.specifier.includes('meta'))).toBe(false);
    expect(found.some((entry) => entry.specifier.includes('thing.js'))).toBe(false);
    expect(found.some((entry) => entry.specifier.includes('not-an-import'))).toBe(false);
  });

  it('finds nothing in a file that imports nothing', () => {
    expect(importSpecifiers('export default class {}')).toEqual([]);
  });
});

describe('resolveRelativeImport', () => {
  it('resolves against the importing file', () => {
    expect(resolveRelativeImport('assets/controllers/hello_controller.js', './util.js'))
      .toBe('assets/controllers/util.js');
    expect(resolveRelativeImport('assets/controllers/hello_controller.js', '../shared/dates.js'))
      .toBe('assets/shared/dates.js');
  });

  it('resolves against a file at the project root', () => {
    expect(resolveRelativeImport('app.js', './util.js')).toBe('util.js');
  });

  it('leaves a bare specifier alone, since it names an importmap key', () => {
    expect(resolveRelativeImport('assets/app.js', '#app/dates')).toBeUndefined();
    expect(resolveRelativeImport('assets/app.js', '@hotwired/stimulus')).toBeUndefined();
  });

  it('refuses to climb out of the project', () => {
    expect(resolveRelativeImport('assets/app.js', '../../etc/passwd')).toBeUndefined();
  });
});
