import { describe, expect, it } from 'vitest';

import { loaderPathsFromTwigConfig, parseTwigConfig } from '../project/twigConfig.js';
import { parseTemplateName, type TwigTemplateName } from '../twig/templateName.js';

import { parseJsonLoosely, resolveLoaderPaths, type ConsoleRunner } from './consoleRunner.js';

function name(raw: string): TwigTemplateName {
  const result = parseTemplateName(raw);
  if (!result.ok) {
    throw new Error(`fixture name "${raw}" did not parse`);
  }
  return result.value;
}

/** The live app's twig.yaml: it declares @Design and nothing else. */
const CONFIG_PATHS = loaderPathsFromTwigConfig(
  parseTwigConfig(
    `twig:\n    paths:\n        '%kernel.project_dir%/design': Design\n`,
  ),
);

/** Trimmed from the live app's real debug:twig output. */
const CONSOLE_JSON = JSON.stringify({
  functions: {},
  loader_paths: {
    '@Design': ['design'],
    '@Maker': ['vendor/symfony/maker-bundle/templates'],
    '@!Maker': ['vendor/symfony/maker-bundle/templates'],
    '@Twig': ['templates/bundles/TwigBundle'],
    '(None)': ['templates'],
  },
});

function runner(result: { ok: boolean; stdout?: string; error?: string }): ConsoleRunner {
  return {
    run: () =>
      Promise.resolve({
        ok: result.ok,
        stdout: result.stdout ?? '',
        error: result.error,
      }),
  };
}

describe('resolveLoaderPaths without a console', () => {
  it('uses the configured paths', async () => {
    const resolved = await resolveLoaderPaths(undefined, CONFIG_PATHS);
    expect(resolved.source).toBe('config');
    expect(resolved.paths.hasNamespace('Design')).toBe(true);
  });

  it('cannot know a bundle namespace, which is the reason the console exists', async () => {
    const resolved = await resolveLoaderPaths(undefined, CONFIG_PATHS);
    expect(resolved.paths.hasNamespace('Twig')).toBe(false);
  });
});

describe('resolveLoaderPaths with a working console', () => {
  it('learns the bundle namespaces', async () => {
    const resolved = await resolveLoaderPaths(runner({ ok: true, stdout: CONSOLE_JSON }), CONFIG_PATHS);

    expect(resolved.source).toBe('console');
    expect(resolved.consoleError).toBeUndefined();
    for (const namespace of ['Design', 'Maker', 'Twig']) {
      expect(resolved.paths.hasNamespace(namespace), namespace).toBe(true);
    }
  });

  it('resolves a bundle template that config alone would report as missing', async () => {
    const resolved = await resolveLoaderPaths(runner({ ok: true, stdout: CONSOLE_JSON }), CONFIG_PATHS);
    expect(resolved.paths.resolveCandidates(name('@Twig/Exception/error404.html.twig'))).toEqual([
      'templates/bundles/TwigBundle/Exception/error404.html.twig',
    ]);
  });

  it('keeps the main namespace', async () => {
    const resolved = await resolveLoaderPaths(runner({ ok: true, stdout: CONSOLE_JSON }), CONFIG_PATHS);
    expect(resolved.paths.resolveCandidates(name('base.html.twig'))).toEqual([
      'templates/base.html.twig',
    ]);
  });

  it('keeps a configured namespace the console did not report', async () => {
    const withoutDesign = JSON.stringify({ loader_paths: { '(None)': ['templates'] } });
    const resolved = await resolveLoaderPaths(
      runner({ ok: true, stdout: withoutDesign }),
      CONFIG_PATHS,
    );
    expect(resolved.paths.hasNamespace('Design')).toBe(true);
  });
});

describe('resolveLoaderPaths when the console fails', () => {
  it('falls back to config and reports why', async () => {
    const resolved = await resolveLoaderPaths(
      runner({ ok: false, error: 'php: command not found' }),
      CONFIG_PATHS,
    );
    expect(resolved.source).toBe('config');
    expect(resolved.consoleError).toBe('php: command not found');
    // The application's own namespace still resolves, which is the point of
    // the fallback: most references are to templates the app declares.
    expect(resolved.paths.hasNamespace('Design')).toBe(true);
  });

  it('falls back when the output is not JSON', async () => {
    const resolved = await resolveLoaderPaths(
      runner({ ok: true, stdout: 'Fatal error: something went wrong' }),
      CONFIG_PATHS,
    );
    expect(resolved.source).toBe('config');
    expect(resolved.consoleError).toMatch(/readable JSON/);
  });
});

describe('parseJsonLoosely', () => {
  it('reads plain JSON', () => {
    expect(parseJsonLoosely('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads JSON preceded by console noise', () => {
    // A deprecation notice or an Xdebug banner ahead of the payload would
    // otherwise discard a perfectly good result.
    const noisy = 'PHP Deprecated:  Something is deprecated\n{"loader_paths":{}}';
    expect(parseJsonLoosely(noisy)).toEqual({ loader_paths: {} });
  });

  it.each([
    ['empty output', ''],
    ['no JSON at all', 'command not found'],
    ['broken JSON', '{"a":'],
    ['a JSON null', 'null'],
  ])('returns undefined for %s', (_label, raw) => {
    expect(parseJsonLoosely(raw)).toBeUndefined();
  });
});
