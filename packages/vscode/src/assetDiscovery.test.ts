import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '@wicker/core';
import { discoverAssets } from './assetDiscovery.js';

const root = 'F:/app';
const project = {
  [`${root}/importmap.php`]: "<?php return ['app' => ['path' => './assets/app.js', 'entrypoint' => true]];",
  [`${root}/config/bundles.php`]: '<?php return [];',
  [`${root}/config/packages/twig.yaml`]: 'twig:\n    default_path: templates\n',
};
const replaced = 'services:\n    asset_mapper.importmap.config_reader:\n        class: App\\AssetMapper\\AppImportMapConfigReader\n';

/*
 * importmap.php is the whole import map only while Symfony's own reader reads
 * it. A project that replaces the reader can generate entries it never writes
 * to the file, so which file says it does is what decides whether a bare
 * import missing from importmap.php may be reported.
 */
describe('asset discovery', () => {
  it('says which configuration file names the importmap reader', async () => {
    const fs = new InMemoryFileSystem({ ...project, [`${root}/config/services.yaml`]: replaced });
    const found = await discoverAssets(fs, root, undefined);
    expect(found.importMapReader).toBe('config/services.yaml');
    // Still read: the entries the file does hold navigate and complete as before.
    expect(found.importMap.map((entry) => entry.specifier)).toEqual(['app']);
  });

  it('finds it below the top of the configuration tree, and nowhere outside it', async () => {
    const nested = new InMemoryFileSystem({ ...project, [`${root}/config/packages/asset_mapper.yaml`]: replaced });
    expect((await discoverAssets(nested, root, undefined)).importMapReader).toBe('config/packages/asset_mapper.yaml');
    const elsewhere = new InMemoryFileSystem({ ...project, [`${root}/docs/services.yaml`]: replaced, [`${root}/config/notes.md`]: replaced });
    expect((await discoverAssets(elsewhere, root, undefined)).importMapReader).toBeUndefined();
  });

  it('says nothing for a project that leaves the reader alone', async () => {
    const found = await discoverAssets(new InMemoryFileSystem(project), root, undefined);
    expect(found.importMapReader).toBeUndefined();
    expect(found.importMapFound).toBe(true);
  });
});
