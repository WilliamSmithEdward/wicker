import { describe, expect, it } from 'vitest';

import { parseYaml } from './yaml.js';

describe('scalars', () => {
  it.each([
    ['a: hello', 'hello'],
    ["a: 'hello'", 'hello'],
    ['a: "hello"', 'hello'],
    ['a: 42', 42],
    ['a: -7', -7],
    ['a: 1.5', 1.5],
    ['a: true', true],
    ['a: false', false],
    ['a: ~', null],
    ['a: null', null],
    ['a:', null],
  ])('%s', (source, expected) => {
    expect(parseYaml(source)).toEqual({ a: expected });
  });

  it('keeps a quoted number as a string', () => {
    expect(parseYaml("a: '42'")).toEqual({ a: '42' });
  });

  it('applies single-quote escaping, where only a doubled quote is special', () => {
    expect(parseYaml("a: 'it''s here'")).toEqual({ a: "it's here" });
    expect(parseYaml("a: 'C:\\path'")).toEqual({ a: 'C:\\path' });
  });

  it('applies double-quote escaping', () => {
    expect(parseYaml('a: "line\\nbreak"')).toEqual({ a: 'line\nbreak' });
  });
});

describe('mappings', () => {
  it('reads a nested mapping', () => {
    expect(parseYaml('twig:\n    paths:\n        design: Design\n')).toEqual({
      twig: { paths: { design: 'Design' } },
    });
  });

  it('reads several keys at one level', () => {
    expect(parseYaml('a: 1\nb: 2\nc: 3\n')).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('reads a quoted key containing a colon and a percent sign', () => {
    // Symfony writes container parameters into keys, and a Windows path in
    // one would otherwise look like a key/value separator.
    expect(parseYaml("paths:\n    '%kernel.project_dir%/design': Design\n")).toEqual({
      paths: { '%kernel.project_dir%/design': 'Design' },
    });
    expect(parseYaml("paths:\n    'C:/apps/design': Design\n")).toEqual({
      paths: { 'C:/apps/design': 'Design' },
    });
  });

  it('reads an environment overlay key', () => {
    expect(parseYaml('when@test:\n    twig:\n        strict_variables: true\n')).toEqual({
      'when@test': { twig: { strict_variables: true } },
    });
  });

  it('only splits on a colon followed by whitespace', () => {
    expect(parseYaml('url: postgresql://app:pass@db:5432/app\n')).toEqual({
      url: 'postgresql://app:pass@db:5432/app',
    });
  });
});

describe('sequences', () => {
  it('reads a block sequence', () => {
    expect(parseYaml('items:\n    - a\n    - b\n')).toEqual({ items: ['a', 'b'] });
  });

  it('reads a flow sequence', () => {
    expect(parseYaml("items: ['a', 'b']")).toEqual({ items: ['a', 'b'] });
  });

  it('does not split a flow sequence inside quotes', () => {
    expect(parseYaml("items: ['a,b', 'c']")).toEqual({ items: ['a,b', 'c'] });
  });

  it('reads a sequence of mappings', () => {
    expect(parseYaml('items:\n    - name: a\n      size: 1\n    - name: b\n      size: 2\n')).toEqual({
      items: [
        { name: 'a', size: 1 },
        { name: 'b', size: 2 },
      ],
    });
  });

  it('reads a top-level sequence', () => {
    expect(parseYaml('- a\n- b\n')).toEqual(['a', 'b']);
  });
});

describe('comments', () => {
  it('drops a whole-line comment', () => {
    expect(parseYaml('# a note\na: 1\n')).toEqual({ a: 1 });
  });

  it('drops a trailing comment', () => {
    expect(parseYaml('a: 1 # a note\n')).toEqual({ a: 1 });
  });

  it('keeps a hash that is part of a value', () => {
    expect(parseYaml("a: '#ffffff'\n")).toEqual({ a: '#ffffff' });
    expect(parseYaml('a: red#ish\n')).toEqual({ a: 'red#ish' });
  });

  it('drops blank lines', () => {
    expect(parseYaml('a: 1\n\n\nb: 2\n')).toEqual({ a: 1, b: 2 });
  });
});

describe('real Symfony configuration', () => {
  it('reads the live twig.yaml', () => {
    const source = `twig:
    file_name_pattern: '*.twig'
    paths:
        # A second Twig namespace.
        '%kernel.project_dir%/design': Design

when@test:
    twig:
        strict_variables: true
`;

    expect(parseYaml(source)).toEqual({
      twig: {
        file_name_pattern: '*.twig',
        paths: { '%kernel.project_dir%/design': 'Design' },
      },
      'when@test': { twig: { strict_variables: true } },
    });
  });

  it('reads a doctrine.yaml shape with deep nesting', () => {
    const source = `doctrine:
    dbal:
        url: '%env(resolve:DATABASE_URL)%'
    orm:
        auto_mapping: true
        mappings:
            App:
                type: attribute
                dir: '%kernel.project_dir%/src/Entity'

when@test:
    doctrine:
        dbal:
            dbname_suffix: '_test%env(default::TEST_TOKEN)%'
`;

    const document = parseYaml(source) as Record<string, Record<string, Record<string, unknown>>>;
    expect(document['doctrine']?.['dbal']?.['url']).toBe('%env(resolve:DATABASE_URL)%');
    expect(document['doctrine']?.['orm']?.['auto_mapping']).toBe(true);
    expect(document['when@test']?.['doctrine']?.['dbal']).toEqual({
      dbname_suffix: '_test%env(default::TEST_TOKEN)%',
    });
  });
});

describe('input it cannot read', () => {
  it.each([
    ['an empty document', ''],
    ['only comments', '# nothing here\n'],
    ['only blank lines', '\n\n'],
  ])('returns undefined for %s', (_label, source) => {
    expect(parseYaml(source)).toBeUndefined();
  });

  it('does not throw on ragged indentation', () => {
    expect(() => parseYaml('a:\n  b: 1\n      c: 2\n d: 3\n')).not.toThrow();
  });

  it('does not throw on an unterminated quote', () => {
    expect(() => parseYaml("a: 'unterminated\n")).not.toThrow();
  });
});
