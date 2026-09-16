import { describe, expect, it } from 'vitest';

import { loaderPathsFromTwigConfig, parseTwigConfig } from '../project/twigConfig.js';
import type { LoaderPathEntry } from '../twig/loaderPaths.js';
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

describe('resolveLoaderPaths with a remembered answer', () => {
  /** What a previous successful run would have handed back to be stored. */
  async function remembered(): Promise<readonly LoaderPathEntry[]> {
    const good = await resolveLoaderPaths(runner({ ok: true, stdout: CONSOLE_JSON }), CONFIG_PATHS);
    const entries = good.consoleEntries;
    if (entries === undefined) {
      throw new Error('a successful run should offer its entries to be remembered');
    }
    return entries;
  }

  it('keeps resolving bundle namespaces when the console stops answering', async () => {
    const resolved = await resolveLoaderPaths(
      runner({ ok: false, error: 'container is not running' }),
      CONFIG_PATHS,
      await remembered(),
    );

    expect(resolved.source).toBe('remembered');
    // The point of the whole mechanism: this is the lookup that would
    // otherwise report correct code as an unregistered namespace.
    expect(resolved.paths.hasNamespace('Twig')).toBe(true);
    expect(resolved.paths.resolveCandidates(name('@Twig/Exception/error404.html.twig'))).toContain(
      'templates/bundles/TwigBundle/Exception/error404.html.twig',
    );
  });

  it('still reports why the console was not used', async () => {
    const resolved = await resolveLoaderPaths(
      runner({ ok: false, error: 'container is not running' }),
      CONFIG_PATHS,
      await remembered(),
    );
    expect(resolved.consoleError).toBe('container is not running');
  });

  it('does not offer a reused answer back for storing', async () => {
    const resolved = await resolveLoaderPaths(
      runner({ ok: false, error: 'down' }),
      CONFIG_PATHS,
      await remembered(),
    );
    // Storing this would be harmless here but would let a fallback overwrite
    // a fresher answer in a host that stored whatever it was given.
    expect(resolved.consoleEntries).toBeUndefined();
  });

  it('ignores it when the console was never asked', async () => {
    // No runner means the console is switched off or the workspace is
    // untrusted. Reusing an answer obtained under other conditions would go
    // behind the user's back.
    const resolved = await resolveLoaderPaths(undefined, CONFIG_PATHS, await remembered());
    expect(resolved.source).toBe('config');
    expect(resolved.paths.hasNamespace('Twig')).toBe(false);
  });

  it('takes an answer the runner itself remembered as remembered, without its callables', async () => {
    const resolved = await resolveLoaderPaths({
      run: () => Promise.resolve({ ok: true, stdout: CONSOLE_JSON, error: 'waiting for the Symfony console', remembered: true }),
    }, CONFIG_PATHS);
    expect(resolved.source).toBe('remembered');
    expect(resolved.paths.hasNamespace('Twig')).toBe(true);
    expect(resolved.consoleError).toBe('waiting for the Symfony console');
    // A stale catalogue would report a filter added since as unknown.
    expect(resolved.callables).toBeUndefined();
    expect(resolved.consoleEntries).toBeUndefined();
  });

  it('falls back to config when there is nothing remembered', async () => {
    const resolved = await resolveLoaderPaths(runner({ ok: false, error: 'down' }), CONFIG_PATHS, []);
    expect(resolved.source).toBe('config');
  });

  it('prefers a fresh answer over the remembered one', async () => {
    const withoutMaker = JSON.stringify({
      loader_paths: { '@Design': ['design'], '(None)': ['templates'] },
    });
    const resolved = await resolveLoaderPaths(
      runner({ ok: true, stdout: withoutMaker }),
      CONFIG_PATHS,
      await remembered(),
    );

    expect(resolved.source).toBe('console');
    // @Maker was in the remembered answer and is not in this one. A bundle
    // removed since then must disappear, or the memory would outlive the fact.
    expect(resolved.paths.hasNamespace('Maker')).toBe(false);
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
