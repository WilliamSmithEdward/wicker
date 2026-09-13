import { describe, expect, it } from 'vitest';

import { parseTemplateName, type TwigTemplateName } from '../twig/templateName.js';

import {
  extensionsFromPatterns,
  loaderPathsFromTwigConfig,
  parseTwigConfig,
} from './twigConfig.js';

function name(raw: string): TwigTemplateName {
  const result = parseTemplateName(raw);
  if (!result.ok) {
    throw new Error(`fixture name "${raw}" did not parse`);
  }
  return result.value;
}

/** The live app's twig.yaml after adding the @Design namespace. */
const LIVE_TWIG_YAML = `twig:
    file_name_pattern: '*.twig'
    paths:
        # A second Twig namespace.
        '%kernel.project_dir%/design': Design

when@test:
    twig:
        strict_variables: true
`;

describe('parseTwigConfig', () => {
  it('reads the live configuration', () => {
    const config = parseTwigConfig(LIVE_TWIG_YAML);
    expect(config.fileNamePatterns).toEqual(['*.twig']);
    expect(config.entries).toEqual([
      { namespace: 'Design', forcesBundleTemplate: false, directories: ['design'] },
    ]);
  });

  it('treats a null or empty namespace as the main namespace', () => {
    const config = parseTwigConfig(
      `twig:\n    paths:\n        '%kernel.project_dir%/legacy': ~\n        '%kernel.project_dir%/extra': ''\n`,
    );
    expect(config.entries).toEqual([
      { namespace: null, forcesBundleTemplate: false, directories: ['legacy'] },
      { namespace: null, forcesBundleTemplate: false, directories: ['extra'] },
    ]);
  });

  it('reads the sequence form as main-namespace directories', () => {
    const config = parseTwigConfig(
      `twig:\n    paths:\n        - '%kernel.project_dir%/a'\n        - '%kernel.project_dir%/b'\n`,
    );
    expect(config.entries.map((e) => e.directories[0])).toEqual(['a', 'b']);
  });

  it('merges a when@dev overlay', () => {
    const config = parseTwigConfig(
      `twig:\n    paths:\n        '%kernel.project_dir%/design': Design\n\nwhen@dev:\n    twig:\n        paths:\n            '%kernel.project_dir%/fixtures': Fixtures\n`,
    );
    expect(config.entries.map((e) => e.namespace)).toEqual(['Design', 'Fixtures']);
  });

  it('ignores a when@prod overlay, since the editor models a dev checkout', () => {
    const config = parseTwigConfig(
      `twig:\n    paths:\n        '%kernel.project_dir%/design': Design\n\nwhen@prod:\n    twig:\n        paths:\n            '%kernel.project_dir%/prod': Prod\n`,
    );
    expect(config.entries.map((e) => e.namespace)).toEqual(['Design']);
  });

  it('drops a path rooted at an unresolvable parameter', () => {
    const config = parseTwigConfig(
      `twig:\n    paths:\n        '%some.other.dir%/x': Other\n        '%kernel.project_dir%/design': Design\n`,
    );
    expect(config.entries.map((e) => e.namespace)).toEqual(['Design']);
  });

  it('accepts a plain relative path with no parameter', () => {
    const config = parseTwigConfig(`twig:\n    paths:\n        'design': Design\n`);
    expect(config.entries[0]?.directories).toEqual(['design']);
  });

  it.each([
    ['malformed yaml', 'twig:\n  paths:\n   - [unclosed\n'],
    ['a yaml scalar', 'just a string'],
    ['an empty document', ''],
    ['a document with no twig key', 'framework:\n    secret: x\n'],
  ])('returns nothing for %s', (_label, raw) => {
    expect(parseTwigConfig(raw).entries).toEqual([]);
  });
});

describe('loaderPathsFromTwigConfig', () => {
  const loaderPaths = loaderPathsFromTwigConfig(parseTwigConfig(LIVE_TWIG_YAML));

  it('always registers the conventional templates root', () => {
    expect(loaderPaths.resolveCandidates(name('home/index.html.twig'))).toEqual([
      'templates/home/index.html.twig',
    ]);
  });

  it('registers the configured namespace', () => {
    expect(loaderPaths.resolveCandidates(name('@Design/card.html.twig'))).toEqual([
      'design/card.html.twig',
    ]);
  });

  it('registers templates/ even when twig.yaml declares nothing', () => {
    const bare = loaderPathsFromTwigConfig(parseTwigConfig(''));
    expect(bare.resolveCandidates(name('base.html.twig'))).toEqual(['templates/base.html.twig']);
  });
});

describe('extensionsFromPatterns', () => {
  it('reads a simple glob', () => {
    expect(extensionsFromPatterns(['*.twig'], ['.fallback'])).toEqual(['.twig']);
  });

  it('reads several globs', () => {
    expect(extensionsFromPatterns(['*.twig', '*.html'], ['.fallback'])).toEqual([
      '.twig',
      '.html',
    ]);
  });

  it('falls back when a pattern is more elaborate than a suffix', () => {
    expect(extensionsFromPatterns(['*.{twig,html}'], ['.twig'])).toEqual(['.twig']);
  });

  it('falls back when nothing is configured', () => {
    expect(extensionsFromPatterns([], ['.twig'])).toEqual(['.twig']);
  });
});
