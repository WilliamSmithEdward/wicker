import { describe, expect, it } from 'vitest';

import { InMemoryFileSystem } from '../fs/inMemoryFileSystem.js';

import { AssetMap, assetExcluded, assetMapperSettings, type AssetMapperSettings } from './assetMap.js';

/**
 * Trimmed from the live application's own
 * `debug:config framework asset_mapper --format=json`, including the
 * uncollapsed `..` segments Symfony reports for bundle directories.
 */
const CONFIG = {
  paths: {
    '/app/vendor/symfony/ux-turbo/src/DependencyInjection/../../assets/dist': '@symfony/ux-turbo',
    '/app/vendor/symfony/stimulus-bundle/src/DependencyInjection/../../assets/dist': '@symfony/stimulus-bundle',
    'assets/': '',
  },
  excluded_patterns: ['*.d.ts', '*/controllers.json'],
  exclude_dotfiles: true,
  public_prefix: '/assets/',
};

const SETTINGS = assetMapperSettings(CONFIG, '/app')!;

describe('assetMapperSettings', () => {
  it('reduces both reported path forms to one project-relative directory', () => {
    expect(SETTINGS.roots).toEqual([
      { directory: 'vendor/symfony/ux-turbo/assets/dist', namespace: '@symfony/ux-turbo' },
      { directory: 'vendor/symfony/stimulus-bundle/assets/dist', namespace: '@symfony/stimulus-bundle' },
      { directory: 'assets', namespace: '' },
    ]);
  });

  it('keeps the exclusions and the public prefix', () => {
    expect(SETTINGS.excludedPatterns).toEqual(['*.d.ts', '*/controllers.json']);
    expect(SETTINGS.excludeDotfiles).toBe(true);
    expect(SETTINGS.publicPrefix).toBe('/assets/');
  });

  it('drops a configured root that lies outside the project', () => {
    // Guessing at a directory the editor cannot reach would produce logical
    // paths that resolve to nothing.
    const outside = assetMapperSettings({ paths: { '/elsewhere/assets': '' } }, '/app');
    expect(outside?.roots).toEqual([]);
  });

  it('reports nothing when the payload is not the expected shape', () => {
    expect(assetMapperSettings(undefined, '/app')).toBeUndefined();
    expect(assetMapperSettings({ enabled: true }, '/app')).toBeUndefined();
  });
});

describe('assetExcluded', () => {
  it('applies a bare filename pattern at any depth', () => {
    expect(assetExcluded(SETTINGS, 'types.d.ts')).toBe(true);
    expect(assetExcluded(SETTINGS, 'deep/nested/types.d.ts')).toBe(true);
    expect(assetExcluded(SETTINGS, 'app.ts')).toBe(false);
  });

  it('applies a pattern containing a slash against the whole relative path', () => {
    expect(assetExcluded(SETTINGS, 'bundles/controllers.json')).toBe(true);
    expect(assetExcluded(SETTINGS, 'controllers.json')).toBe(false);
  });

  /*
   * The distinction the two stars carry, which nothing covered while `**` was
   * handled by substituting a placeholder and putting it back afterwards.
   */
  it('crosses segments for ** and stops at one for *', () => {
    const settings: AssetMapperSettings = {
      ...SETTINGS,
      excludedPatterns: ['vendor/**', 'styles/*.css'],
    };
    expect(assetExcluded(settings, 'vendor/pkg/deep/file.js')).toBe(true);
    expect(assetExcluded(settings, 'vendor/file.js')).toBe(true);
    expect(assetExcluded(settings, 'styles/app.css')).toBe(true);
    // A single star does not cross a separator, so the nested sheet stays.
    expect(assetExcluded(settings, 'styles/theme/app.css')).toBe(false);
    expect(assetExcluded(settings, 'assets/vendor/file.js')).toBe(false);
  });

  it('takes a pattern literally apart from its stars', () => {
    const settings: AssetMapperSettings = { ...SETTINGS, excludedPatterns: ['a.b+c(d).js'] };
    expect(assetExcluded(settings, 'a.b+c(d).js')).toBe(true);
    expect(assetExcluded(settings, 'axbxcxdx.js')).toBe(false);
  });

  it('excludes dotfiles only while the setting says so', () => {
    expect(assetExcluded(SETTINGS, '.keep')).toBe(true);
    expect(assetExcluded(SETTINGS, 'styles/.hidden.css')).toBe(true);
    const kept: AssetMapperSettings = { ...SETTINGS, excludeDotfiles: false };
    expect(assetExcluded(kept, '.keep')).toBe(false);
  });
});

describe('AssetMap', () => {
  const FILES = {
    '/app/assets/app.js': 'x',
    '/app/assets/styles/app.css': 'x',
    '/app/assets/controllers/hello_controller.js': 'x',
    '/app/assets/types.d.ts': 'x',
    '/app/assets/.keep': 'x',
    '/app/assets/node_modules/pkg/index.js': 'x',
    '/app/vendor/symfony/ux-turbo/assets/dist/turbo_controller.js': 'x',
  };

  async function build(settings = SETTINGS): Promise<AssetMap> {
    return AssetMap.build(new InMemoryFileSystem(FILES), '/app', settings);
  }

  it('names every mapped file the way a template would ask for it', async () => {
    expect((await build()).logicalPaths()).toEqual([
      '@symfony/ux-turbo/turbo_controller.js',
      'app.js',
      'controllers/hello_controller.js',
      'styles/app.css',
    ]);
  });

  it('leaves out what AssetMapper would not serve', async () => {
    const map = await build();
    expect(map.lookup('types.d.ts')).toBeUndefined();
    expect(map.lookup('.keep')).toBeUndefined();
    expect(map.lookup('node_modules/pkg/index.js')).toBeUndefined();
  });

  it('resolves a reference that addresses part of an asset', async () => {
    // A fragment selects a symbol inside an SVG and a query busts a cache.
    // Neither changes which file is named, and matching them literally would
    // make a working reference look broken.
    const map = await build();
    expect(map.lookup('styles/app.css#top')?.projectPath).toBe('assets/styles/app.css');
    expect(map.lookup('styles/app.css?v=2')?.projectPath).toBe('assets/styles/app.css');
    expect(map.lookup('styles/missing.css#top')).toBeUndefined();
  });

  it('resolves a logical path to its file and back', async () => {
    const map = await build();
    expect(map.lookup('styles/app.css')?.projectPath).toBe('assets/styles/app.css');
    expect(map.forProjectPath('assets/styles/app.css')?.logicalPath).toBe('styles/app.css');
  });

  it('reports truncation rather than walking a vendor tree without bound', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) { many[`/app/assets/file${i}.js`] = 'x'; }
    const map = await AssetMap.build(new InMemoryFileSystem(many), '/app', SETTINGS, { maxFiles: 10 });
    expect(map.truncated).toBe(true);
    expect(map.size).toBeLessThanOrEqual(10);
  });

  it('is empty rather than absent when nothing is configured', () => {
    expect(AssetMap.empty().logicalPaths()).toEqual([]);
    expect(AssetMap.empty().truncated).toBe(false);
  });
});
