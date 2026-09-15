import { describe, expect, it } from 'vitest';

import {
  classToProjectPaths,
  parseComposerManifest,
  type ComposerManifest,
} from './composer.js';

/**
 * The shape of the live test app's composer.json (Symfony 8.1 skeleton).
 * Built as an object and stringified so the PHP namespace separators stay
 * readable instead of turning into four-backslash JSON escapes.
 */
const REAL_MANIFEST = {
  name: 'symfony/skeleton',
  type: 'project',
  license: 'MIT',
  require: {
    php: '>=8.5.9',
    'ext-ctype': '*',
    'symfony/console': '8.1.*',
    'symfony/framework-bundle': '8.1.*',
    'symfony/twig-bundle': '8.1.*',
    'symfony/yaml': '8.1.*',
  },
  'require-dev': {
    'phpunit/phpunit': '^13.3',
    'symfony/maker-bundle': '^1.68',
  },
  autoload: { 'psr-4': { 'App\\': 'src/' } },
  'autoload-dev': { 'psr-4': { 'App\\Tests\\': 'tests/' } },
};

function parse(document: unknown): ComposerManifest {
  const manifest = parseComposerManifest(JSON.stringify(document));
  if (manifest === undefined) {
    throw new Error('expected the manifest to parse');
  }
  return manifest;
}

describe('parseComposerManifest', () => {
  const manifest = parse(REAL_MANIFEST);

  it('reads identity fields', () => {
    expect(manifest.name).toBe('symfony/skeleton');
    expect(manifest.type).toBe('project');
  });

  it('merges require and require-dev', () => {
    expect(manifest.requirements.has('symfony/framework-bundle')).toBe(true);
    expect(manifest.requirements.has('symfony/maker-bundle')).toBe(true);
    expect(manifest.requirements.has('doctrine/orm')).toBe(false);
  });

  it('reads psr-4 from both autoload blocks, longest prefix first', () => {
    expect(manifest.psr4).toEqual([
      { prefix: 'App\\Tests\\', directories: ['tests'] },
      { prefix: 'App\\', directories: ['src'] },
    ]);
  });

  it.each([
    ['not json at all', '{'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON string', '"hello"'],
    ['JSON null', 'null'],
  ])('returns undefined for %s', (_label, raw) => {
    expect(parseComposerManifest(raw)).toBeUndefined();
  });

  it('tolerates a manifest with nothing Wicker needs', () => {
    const empty = parse({});
    expect(empty.name).toBeUndefined();
    expect(empty.psr4).toEqual([]);
    expect(empty.requirements.size).toBe(0);
  });

  it('skips malformed sections instead of failing the whole parse', () => {
    const manifestWithJunk = parse({
      name: 'acme/app',
      require: 'not-an-object',
      autoload: { 'psr-4': { 'App\\': 42, 'Ok\\': 'src/' } },
    });
    expect(manifestWithJunk.name).toBe('acme/app');
    expect(manifestWithJunk.requirements.size).toBe(0);
    expect(manifestWithJunk.psr4).toEqual([{ prefix: 'Ok\\', directories: ['src'] }]);
  });

  it('accepts an array of directories for one prefix', () => {
    const multi = parse({ autoload: { 'psr-4': { 'App\\': ['src/', 'lib/'] } } });
    expect(multi.psr4).toEqual([{ prefix: 'App\\', directories: ['src', 'lib'] }]);
  });

  it('accepts an empty target, which maps a prefix onto the project root', () => {
    const rootMapped = parse({ autoload: { 'psr-4': { 'App\\': '' } } });
    expect(rootMapped.psr4).toEqual([{ prefix: 'App\\', directories: [''] }]);
  });
});

describe('classToProjectPaths', () => {
  const manifest = parse(REAL_MANIFEST);

  it('maps an application class', () => {
    expect(classToProjectPaths(manifest, 'App\\Controller\\HomeController')).toEqual([
      'src/Controller/HomeController.php',
    ]);
  });

  it('prefers the longest matching prefix', () => {
    expect(classToProjectPaths(manifest, 'App\\Tests\\Controller\\HomeControllerTest')).toEqual([
      'tests/Controller/HomeControllerTest.php',
    ]);
  });

  it('tolerates a leading separator, as attribute strings often carry one', () => {
    expect(classToProjectPaths(manifest, '\\App\\Controller\\HomeController')).toEqual([
      'src/Controller/HomeController.php',
    ]);
  });

  it('offers every directory registered for the prefix', () => {
    const multi = parse({ autoload: { 'psr-4': { 'App\\': ['src/', 'lib/'] } } });
    expect(classToProjectPaths(multi, 'App\\Service\\Mailer')).toEqual([
      'src/Service/Mailer.php',
      'lib/Service/Mailer.php',
    ]);
  });

  it('maps against a root-mapped prefix', () => {
    const rootMapped = parse({ autoload: { 'psr-4': { 'App\\': '' } } });
    expect(classToProjectPaths(rootMapped, 'App\\Kernel')).toEqual(['Kernel.php']);
  });

  it.each([
    ['a vendor class outside every prefix', 'Symfony\\Component\\HttpFoundation\\Response'],
    ['the bare prefix itself', 'App\\'],
    ['an empty name', ''],
  ])('returns nothing for %s', (_label, className) => {
    expect(classToProjectPaths(manifest, className)).toEqual([]);
  });
});

