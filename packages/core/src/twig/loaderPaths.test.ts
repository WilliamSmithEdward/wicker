import { describe, expect, it } from 'vitest';

import { TwigLoaderPaths } from './loaderPaths.js';
import { parseTemplateName, type TwigTemplateName } from './templateName.js';

/**
 * Captured verbatim from the live test app:
 *   docker exec symfonyapp-php-1 php bin/console debug:twig --format=json
 * on Symfony 8.1.6 / Twig 3.28.0. Keeping the real shape here means a Symfony
 * change to this contract fails a test rather than silently degrading lookups.
 */
const REAL_DEBUG_TWIG_PAYLOAD = {
  functions: { parent: null, block: null },
  filters: {},
  tests: {},
  globals: { app: [] },
  loader_paths: {
    '@Maker': ['vendor/symfony/maker-bundle/templates'],
    '@!Maker': ['vendor/symfony/maker-bundle/templates'],
    '(None)': ['templates'],
  },
};

function name(raw: string): TwigTemplateName {
  const result = parseTemplateName(raw);
  if (!result.ok) {
    throw new Error(`fixture name "${raw}" did not parse`);
  }
  return result.value;
}

describe('TwigLoaderPaths.default', () => {
  it('resolves main-namespace templates under templates/', () => {
    const paths = TwigLoaderPaths.default();
    expect(paths.resolveCandidates(name('home/index.html.twig'))).toEqual([
      'templates/home/index.html.twig',
    ]);
  });

  it('reports no candidates for an unregistered namespace', () => {
    const paths = TwigLoaderPaths.default();
    expect(paths.resolveCandidates(name('@Admin/x.html.twig'))).toEqual([]);
    expect(paths.hasNamespace('Admin')).toBe(false);
  });
});

describe('TwigLoaderPaths.fromDebugTwigJson', () => {
  const paths = TwigLoaderPaths.fromDebugTwigJson(REAL_DEBUG_TWIG_PAYLOAD);

  it('maps (None) onto the main namespace', () => {
    expect(paths.resolveCandidates(name('home/index.html.twig'))).toEqual([
      'templates/home/index.html.twig',
    ]);
  });

  it('maps a bundle namespace', () => {
    expect(paths.resolveCandidates(name('@Maker/foo.html.twig'))).toEqual([
      'vendor/symfony/maker-bundle/templates/foo.html.twig',
    ]);
  });

  it('keeps the @! variant separate from the plain namespace', () => {
    expect(paths.resolveCandidates(name('@!Maker/foo.html.twig'))).toEqual([
      'vendor/symfony/maker-bundle/templates/foo.html.twig',
    ]);
  });

  it('lists the namespaces it knows, main included as null', () => {
    // Compared as a set: the public contract is which namespaces exist, not
    // their order, and a default sort() would stringify the null.
    expect(new Set(paths.namespaces())).toEqual(new Set([null, 'Maker']));
  });

  it('lists the main namespace once even though (None) and @! keys both appear', () => {
    expect(paths.namespaces()).toHaveLength(2);
  });

  it('accepts a bare loader_paths object as well as the full document', () => {
    const bare = TwigLoaderPaths.fromDebugTwigJson(REAL_DEBUG_TWIG_PAYLOAD.loader_paths);
    expect(bare.resolveCandidates(name('home/index.html.twig'))).toEqual([
      'templates/home/index.html.twig',
    ]);
  });
});

describe('TwigLoaderPaths override ordering', () => {
  it('tries an application override before the bundle copy', () => {
    const paths = TwigLoaderPaths.fromDebugTwigJson({
      loader_paths: {
        '@Maker': ['templates/bundles/MakerBundle', 'vendor/symfony/maker-bundle/templates'],
        '@!Maker': ['vendor/symfony/maker-bundle/templates'],
        '(None)': ['templates'],
      },
    });

    expect(paths.resolveCandidates(name('@Maker/foo.html.twig'))).toEqual([
      'templates/bundles/MakerBundle/foo.html.twig',
      'vendor/symfony/maker-bundle/templates/foo.html.twig',
    ]);
  });

  it('skips the override for the @! form, which is its whole purpose', () => {
    const paths = TwigLoaderPaths.fromDebugTwigJson({
      loader_paths: {
        '@Maker': ['templates/bundles/MakerBundle', 'vendor/symfony/maker-bundle/templates'],
        '@!Maker': ['vendor/symfony/maker-bundle/templates'],
      },
    });

    expect(paths.resolveCandidates(name('@!Maker/foo.html.twig'))).toEqual([
      'vendor/symfony/maker-bundle/templates/foo.html.twig',
    ]);
  });

  it('falls back to the plain namespace when no @! entry is registered', () => {
    const paths = TwigLoaderPaths.fromEntries([
      { namespace: 'Admin', forcesBundleTemplate: false, directories: ['templates/admin'] },
    ]);
    expect(paths.resolveCandidates(name('@!Admin/x.html.twig'))).toEqual(['templates/admin/x.html.twig']);
  });
});

describe('TwigLoaderPaths normalisation', () => {
  it('normalises separators, ./ prefixes, and trailing slashes', () => {
    const paths = TwigLoaderPaths.fromEntries([
      {
        namespace: null,
        forcesBundleTemplate: false,
        directories: ['./templates/', 'extra\\views', 'double//slash'],
      },
    ]);
    expect(paths.resolveCandidates(name('a.html.twig'))).toEqual([
      'templates/a.html.twig',
      'extra/views/a.html.twig',
      'double/slash/a.html.twig',
    ]);
  });

  it('merges repeated namespaces without duplicating directories', () => {
    const paths = TwigLoaderPaths.fromEntries([
      { namespace: 'Admin', forcesBundleTemplate: false, directories: ['templates/admin'] },
      { namespace: 'Admin', forcesBundleTemplate: false, directories: ['templates/admin', 'other'] },
    ]);
    expect(paths.directoriesFor('Admin')).toEqual(['templates/admin', 'other']);
  });
});

describe('TwigLoaderPaths malformed input', () => {
  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', [1, 2, 3]],
    ['an empty document', {}],
    ['loader_paths of the wrong type', { loader_paths: 'nope' }],
    ['entries with no usable directories', { loader_paths: { '@A': [], '@B': [42] } }],
  ])('falls back to the default map for %s', (_label, payload) => {
    const paths = TwigLoaderPaths.fromDebugTwigJson(payload);
    expect(paths.resolveCandidates(name('home/index.html.twig'))).toEqual([
      'templates/home/index.html.twig',
    ]);
  });

  it('keeps the valid half of a partially malformed payload', () => {
    const paths = TwigLoaderPaths.fromDebugTwigJson({
      loader_paths: { '@Good': ['templates/good'], '@Bad': 'not-an-array' },
    });
    expect(paths.resolveCandidates(name('@Good/x.html.twig'))).toEqual(['templates/good/x.html.twig']);
    expect(paths.hasNamespace('Bad')).toBe(false);
  });
});
