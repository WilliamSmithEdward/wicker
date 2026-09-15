import { describe, expect, it } from 'vitest';

import { InMemoryFileSystem } from '../fs/inMemoryFileSystem.js';

import { TwigLoaderPaths } from './loaderPaths.js';
import { TwigTemplateIndex } from './templateIndex.js';
import { parseTemplateName, type TwigTemplateName } from './templateName.js';

function name(raw: string): TwigTemplateName {
  const result = parseTemplateName(raw);
  if (!result.ok) {
    throw new Error(`fixture name "${raw}" did not parse`);
  }
  return result.value;
}

/** Mirrors the live app: templates/ plus the MakerBundle namespace. */
const LIVE_LOADER_PATHS = TwigLoaderPaths.fromDebugTwigJson({
  loader_paths: {
    '@Maker': ['vendor/symfony/maker-bundle/templates'],
    '@!Maker': ['vendor/symfony/maker-bundle/templates'],
    '(None)': ['templates'],
  },
});

const LIVE_FILES = {
  '/app/templates/base.html.twig': 'base',
  '/app/templates/home/index.html.twig': 'index',
  '/app/vendor/symfony/maker-bundle/templates/maker/Controller.tpl.php': 'tpl',
  '/app/vendor/symfony/maker-bundle/templates/form/Type.tpl.php': 'tpl',
};

describe('TwigTemplateIndex.build', () => {
  it('indexes main-namespace templates under their bare names', async () => {
    const fs = new InMemoryFileSystem(LIVE_FILES);
    const index = await TwigTemplateIndex.build(fs, '/app', LIVE_LOADER_PATHS);

    expect(index.allNames()).toEqual(['base.html.twig', 'home/index.html.twig']);
    expect(index.lookup(name('home/index.html.twig'))?.projectPath).toBe(
      'templates/home/index.html.twig',
    );
  });

  /*
   * A name is written by a person, and Twig normalises it before looking it
   * up. Indexing under the normalised form and then keying a query on the raw
   * text reports a template that exists as missing.
   */
  it('finds a template under the name as written, not only as normalised', async () => {
    const fs = new InMemoryFileSystem(LIVE_FILES);
    const index = await TwigTemplateIndex.build(fs, '/app', LIVE_LOADER_PATHS);
    for (const written of ['/home/index.html.twig', 'home\\index.html.twig',
      'home//index.html.twig', './home/index.html.twig', 'home/../home/index.html.twig']) {
      expect(index.lookup(written)?.projectPath, written).toBe('templates/home/index.html.twig');
      expect(index.has(written), written).toBe(true);
      expect(index.candidatesFor(written).length, written).toBe(1);
    }
    // A name that resolves to nothing is still not found.
    expect(index.lookup('/home/missing.html.twig')).toBeUndefined();
  });

  it('ignores files that do not match the indexed extensions', async () => {
    const fs = new InMemoryFileSystem(LIVE_FILES);
    const index = await TwigTemplateIndex.build(fs, '/app', LIVE_LOADER_PATHS);
    // The MakerBundle ships .tpl.php files, which are not Twig templates.
    expect(index.allNames()).not.toContain('@Maker/maker/Controller.tpl.php');
  });

  it('indexes a namespace when it holds real twig files', async () => {
    const fs = new InMemoryFileSystem({
      ...LIVE_FILES,
      '/app/vendor/symfony/maker-bundle/templates/email.html.twig': 'mail',
    });
    const index = await TwigTemplateIndex.build(fs, '/app', LIVE_LOADER_PATHS);

    expect(index.lookup(name('@Maker/email.html.twig'))?.projectPath).toBe(
      'vendor/symfony/maker-bundle/templates/email.html.twig',
    );
    expect(index.lookup(name('@!Maker/email.html.twig'))?.projectPath).toBe(
      'vendor/symfony/maker-bundle/templates/email.html.twig',
    );
  });

  it('walks nested directories', async () => {
    const fs = new InMemoryFileSystem({
      '/app/templates/admin/user/list/table.html.twig': 'x',
    });
    const index = await TwigTemplateIndex.build(fs, '/app', TwigLoaderPaths.default());
    expect(index.allNames()).toEqual(['admin/user/list/table.html.twig']);
  });

  it('produces an empty index when nothing is there', async () => {
    const fs = new InMemoryFileSystem();
    const index = await TwigTemplateIndex.build(fs, '/app', TwigLoaderPaths.default());
    expect(index.fileCount).toBe(0);
    expect(index.nameCount).toBe(0);
    expect(index.allNames()).toEqual([]);
    expect(index.truncated).toBe(false);
  });

  it('honours a custom extension list', async () => {
    const fs = new InMemoryFileSystem({
      '/app/templates/a.twig': 'x',
      '/app/templates/b.html': 'x',
    });
    const index = await TwigTemplateIndex.build(fs, '/app', TwigLoaderPaths.default(), {
      extensions: ['.twig', '.html'],
    });
    expect(index.allNames()).toEqual(['a.twig', 'b.html']);
  });

  it('skips directories it is told to skip', async () => {
    const fs = new InMemoryFileSystem({
      '/app/templates/a.twig': 'x',
      '/app/templates/node_modules/pkg/b.twig': 'x',
      '/app/templates/.git/c.twig': 'x',
    });
    const index = await TwigTemplateIndex.build(fs, '/app', TwigLoaderPaths.default());
    expect(index.allNames()).toEqual(['a.twig']);
  });

  it('stops and reports truncation at the file bound', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i += 1) {
      files[`/app/templates/t${i}.twig`] = 'x';
    }
    const index = await TwigTemplateIndex.build(fs2(files), '/app', TwigLoaderPaths.default(), {
      maxFiles: 10,
    });
    expect(index.truncated).toBe(true);
    expect(index.fileCount).toBeLessThanOrEqual(10);
  });
});

function fs2(files: Record<string, string>): InMemoryFileSystem {
  return new InMemoryFileSystem(files);
}

describe('TwigTemplateIndex override ordering', () => {
  const OVERRIDE_PATHS = TwigLoaderPaths.fromDebugTwigJson({
    loader_paths: {
      '@Maker': ['templates/bundles/MakerBundle', 'vendor/symfony/maker-bundle/templates'],
      '@!Maker': ['vendor/symfony/maker-bundle/templates'],
      '(None)': ['templates'],
    },
  });

  const OVERRIDE_FILES = {
    '/app/templates/bundles/MakerBundle/email.html.twig': 'override',
    '/app/vendor/symfony/maker-bundle/templates/email.html.twig': 'original',
  };

  it('resolves to the application override, not the bundle copy', async () => {
    const index = await TwigTemplateIndex.build(
      new InMemoryFileSystem(OVERRIDE_FILES),
      '/app',
      OVERRIDE_PATHS,
    );
    const winner = index.lookup(name('@Maker/email.html.twig'));
    expect(winner?.projectPath).toBe('templates/bundles/MakerBundle/email.html.twig');
    expect(winner?.shadowed).toBe(false);
  });

  it('keeps the shadowed copy and marks it', async () => {
    const index = await TwigTemplateIndex.build(
      new InMemoryFileSystem(OVERRIDE_FILES),
      '/app',
      OVERRIDE_PATHS,
    );
    const candidates = index.candidatesFor(name('@Maker/email.html.twig'));
    expect(candidates).toHaveLength(2);
    expect(candidates[1]?.projectPath).toBe('vendor/symfony/maker-bundle/templates/email.html.twig');
    expect(candidates[1]?.shadowed).toBe(true);
  });

  it('counts files and names separately, because one file answers to several', async () => {
    const index = await TwigTemplateIndex.build(
      new InMemoryFileSystem(OVERRIDE_FILES),
      '/app',
      OVERRIDE_PATHS,
    );

    // Two files on disk, reachable as @Maker/email.html.twig,
    // @!Maker/email.html.twig and bundles/MakerBundle/email.html.twig. A
    // reader counting templates means the files, so the two must not be
    // conflated behind one ambiguous total.
    expect(index.fileCount).toBe(2);
    expect(index.nameCount).toBe(3);
  });

  it('lets the @! form reach past the override, which is its purpose', async () => {
    const index = await TwigTemplateIndex.build(
      new InMemoryFileSystem(OVERRIDE_FILES),
      '/app',
      OVERRIDE_PATHS,
    );
    expect(index.lookup(name('@!Maker/email.html.twig'))?.projectPath).toBe(
      'vendor/symfony/maker-bundle/templates/email.html.twig',
    );
  });
});

describe('TwigTemplateIndex reverse lookup', () => {
  it('reports the name a file answers to', async () => {
    const index = await TwigTemplateIndex.build(
      new InMemoryFileSystem(LIVE_FILES),
      '/app',
      LIVE_LOADER_PATHS,
    );
    expect(index.namesForProjectPath('templates/home/index.html.twig')).toEqual([
      'home/index.html.twig',
    ]);
  });

  it('reports every name when one file is reachable through two namespaces', async () => {
    const index = await TwigTemplateIndex.build(
      new InMemoryFileSystem({ '/app/shared/a.twig': 'x' }),
      '/app',
      TwigLoaderPaths.fromEntries([
        { namespace: null, forcesBundleTemplate: false, directories: ['shared'] },
        { namespace: 'Shared', forcesBundleTemplate: false, directories: ['shared'] },
      ]),
    );
    expect([...index.namesForProjectPath('shared/a.twig')].sort()).toEqual([
      '@Shared/a.twig',
      'a.twig',
    ]);
  });

  it('returns nothing for a file that is not a template', async () => {
    const index = await TwigTemplateIndex.build(
      new InMemoryFileSystem(LIVE_FILES),
      '/app',
      LIVE_LOADER_PATHS,
    );
    expect(index.namesForProjectPath('src/Controller/HomeController.php')).toEqual([]);
  });
});

describe('TwigTemplateIndex queries', () => {
  it('accepts a raw string as well as a parsed name', async () => {
    const index = await TwigTemplateIndex.build(
      new InMemoryFileSystem(LIVE_FILES),
      '/app',
      LIVE_LOADER_PATHS,
    );
    expect(index.has('home/index.html.twig')).toBe(true);
    expect(index.has('home/missing.html.twig')).toBe(false);
  });

  it('sorts names once and keeps answering with the same list', async () => {
    const index = await TwigTemplateIndex.build(
      new InMemoryFileSystem({
        '/app/templates/b.twig': 'x',
        '/app/templates/a.twig': 'x',
      }),
      '/app',
      TwigLoaderPaths.default(),
    );
    expect(index.allNames()).toEqual(['a.twig', 'b.twig']);
    // Identity, because an index never changes after it is built and the
    // sidebar asks for this while drawing every namespace.
    expect(index.allNames()).toBe(index.allNames());
  });
});
