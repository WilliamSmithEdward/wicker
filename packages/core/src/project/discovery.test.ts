import { describe, expect, it } from 'vitest';

import { InMemoryFileSystem } from '../fs/inMemoryFileSystem.js';

import {
  discoverSymfonyProject,
  inspectDirectory,
  isSymfonyProject,
} from './discovery.js';

const SYMFONY_COMPOSER = JSON.stringify({
  name: 'symfony/skeleton',
  type: 'project',
  require: {
    'symfony/framework-bundle': '8.1.*',
    'symfony/twig-bundle': '8.1.*',
  },
  autoload: { 'psr-4': { 'App\\': 'src/' } },
});

/** A faithful minimal copy of the live test app's layout. */
function symfonyApp(root: string): Record<string, string> {
  return {
    [`${root}/composer.json`]: SYMFONY_COMPOSER,
    [`${root}/bin/console`]: '#!/usr/bin/env php',
    [`${root}/config/bundles.php`]: '<?php return [];',
    [`${root}/src/Kernel.php`]: '<?php',
    [`${root}/src/Controller/HomeController.php`]: '<?php',
    [`${root}/templates/base.html.twig`]: 'base',
    [`${root}/templates/home/index.html.twig`]: 'index',
  };
}

describe('isSymfonyProject', () => {
  it.each([['framework-bundle'], ['bundles-config'], ['kernel-class']] as const)(
    'accepts %s on its own',
    (item) => {
      expect(isSymfonyProject([item])).toBe(true);
    },
  );

  it.each([
    ['console-script', 'describes any Console-based CLI tool'],
    ['symfony-package', 'describes any library using a component'],
    ['templates-directory', 'describes almost anything'],
    ['twig-bundle', 'can be required without an application around it'],
  ] as const)('rejects %s alone, which %s', (item, _reason) => {
    expect(isSymfonyProject([item])).toBe(false);
  });

  it('rejects every weak signal even in combination', () => {
    expect(
      isSymfonyProject(['console-script', 'symfony-package', 'templates-directory', 'twig-bundle']),
    ).toBe(false);
  });

  it('rejects no evidence', () => {
    expect(isSymfonyProject([])).toBe(false);
  });
});

describe('inspectDirectory', () => {
  it('identifies a Symfony application and records its evidence', async () => {
    const fs = new InMemoryFileSystem(symfonyApp('/app'));
    const project = await inspectDirectory(fs, '/app');

    expect(project).toBeDefined();
    expect(project?.root).toBe('/app');
    expect(project?.hasTwig).toBe(true);
    expect(project?.evidence).toEqual([
      'framework-bundle',
      'twig-bundle',
      'symfony-package',
      'bundles-config',
      'kernel-class',
      'console-script',
      'templates-directory',
    ]);
  });

  it('exposes the parsed manifest', async () => {
    const fs = new InMemoryFileSystem(symfonyApp('/app'));
    const project = await inspectDirectory(fs, '/app');
    expect(project?.manifest.name).toBe('symfony/skeleton');
    expect(project?.manifest.psr4).toEqual([{ prefix: 'App\\', directories: ['src'] }]);
  });

  it('normalises the root it reports', async () => {
    const fs = new InMemoryFileSystem(symfonyApp('F:/GitHub/app'));
    const project = await inspectDirectory(fs, 'F:\\GitHub\\app\\');
    expect(project?.root).toBe('F:/GitHub/app');
  });

  it('returns undefined where there is no composer.json', async () => {
    const fs = new InMemoryFileSystem(symfonyApp('/app'));
    await expect(inspectDirectory(fs, '/elsewhere')).resolves.toBeUndefined();
  });

  it('returns undefined for a malformed composer.json', async () => {
    const fs = new InMemoryFileSystem({ '/app/composer.json': '{ broken' });
    await expect(inspectDirectory(fs, '/app')).resolves.toBeUndefined();
  });

  it('declines a plain Console tool, which has a bin/console but no application', async () => {
    const fs = new InMemoryFileSystem({
      '/tool/composer.json': JSON.stringify({ require: { 'symfony/console': '7.0.*' } }),
      '/tool/bin/console': '#!/usr/bin/env php',
    });
    await expect(inspectDirectory(fs, '/tool')).resolves.toBeUndefined();
  });

  it('accepts an application identified only by config/bundles.php', async () => {
    const fs = new InMemoryFileSystem({
      '/app/composer.json': JSON.stringify({ require: { 'symfony/runtime': '8.1.*' } }),
      '/app/config/bundles.php': '<?php return [];',
    });
    const project = await inspectDirectory(fs, '/app');
    expect(project?.evidence).toContain('bundles-config');
  });

  it('declines a library that merely depends on a Symfony component', async () => {
    const fs = new InMemoryFileSystem({
      '/lib/composer.json': JSON.stringify({
        type: 'library',
        require: { 'symfony/string': '7.0.*' },
      }),
    });
    await expect(inspectDirectory(fs, '/lib')).resolves.toBeUndefined();
  });

  it('reports hasTwig false when nothing indicates Twig', async () => {
    const fs = new InMemoryFileSystem({
      '/api/composer.json': JSON.stringify({
        require: { 'symfony/framework-bundle': '8.1.*' },
      }),
    });
    const project = await inspectDirectory(fs, '/api');
    expect(project?.hasTwig).toBe(false);
  });
});

describe('discoverSymfonyProject', () => {
  const fs = new InMemoryFileSystem(symfonyApp('/app'));

  it('finds the project from a nested directory', async () => {
    const project = await discoverSymfonyProject(fs, '/app/src/Controller');
    expect(project?.root).toBe('/app');
  });

  it('finds the project from the root itself', async () => {
    const project = await discoverSymfonyProject(fs, '/app');
    expect(project?.root).toBe('/app');
  });

  it('returns undefined when no ancestor is a project', async () => {
    await expect(discoverSymfonyProject(fs, '/somewhere/else')).resolves.toBeUndefined();
  });

  it('prefers the nearest project in a monorepo', async () => {
    const monorepo = new InMemoryFileSystem({
      ...symfonyApp('/repo'),
      ...symfonyApp('/repo/apps/api'),
    });
    const nested = await discoverSymfonyProject(monorepo, '/repo/apps/api/src/Controller');
    expect(nested?.root).toBe('/repo/apps/api');

    const outer = await discoverSymfonyProject(monorepo, '/repo/src');
    expect(outer?.root).toBe('/repo');
  });
});

