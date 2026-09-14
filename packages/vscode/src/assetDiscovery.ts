import { AssetMap, assetMapperSettings, joinProjectPath, parseImportMap, parseJsonLoosely,
  type AssetMapperSettings, type ConsoleRunner, type ImportMapEntry, type WickerFileSystem } from '@wicker/core';

export interface AssetDiscovery {
  /** Logical path to file, for `asset()` and bare imports. */
  readonly map: AssetMap;
  /** Entries of `importmap.php`, which is where a `#` alias is declared. */
  readonly importMap: readonly ImportMapEntry[];
  readonly settings: AssetMapperSettings | undefined;
  readonly status: string;
}

const UNAVAILABLE: AssetDiscovery = {
  map: AssetMap.empty(), importMap: [], settings: undefined,
  status: 'unavailable; console required for asset paths',
};

/**
 * Asks Symfony where its assets live, then walks them.
 *
 * Two halves that fail independently. The configured roots come only from the
 * console, because a bundle's asset directory is registered in PHP and appears
 * in no configuration file. `importmap.php` is a file in the project and is
 * read whether or not the console answers, so an alias stays resolvable when
 * the container is down.
 */
export async function discoverAssets(
  fileSystem: WickerFileSystem,
  root: string,
  runner: ConsoleRunner | undefined,
): Promise<AssetDiscovery> {
  const importMap = parseImportMap(await fileSystem.readFile(joinProjectPath(root, 'importmap.php')) ?? '');
  if (!runner) {
    return { ...UNAVAILABLE, importMap };
  }

  const [config, directory] = await Promise.all([
    runner.run(['debug:config', 'framework', 'asset_mapper', '--format=json', '--no-ansi', '--no-interaction']),
    runner.run(['debug:container', '--parameter=kernel.project_dir', '--format=json', '--no-ansi', '--no-interaction']),
  ]);

  const runtimeRoot = directory.ok
    ? object(parseJsonLoosely(directory.stdout))?.['kernel.project_dir']
    : undefined;
  if (!config.ok || typeof runtimeRoot !== 'string') {
    return { ...UNAVAILABLE, importMap, status: `unavailable; ${config.error ?? 'the project directory could not be read'}` };
  }

  const settings = assetMapperSettings(parseJsonLoosely(config.stdout), runtimeRoot);
  if (!settings) {
    return { ...UNAVAILABLE, importMap, status: 'unavailable; the asset mapper configuration could not be read' };
  }

  const map = await AssetMap.build(fileSystem, root, settings);
  return {
    map, importMap, settings,
    status: `${map.size} assets from ${settings.roots.length} configured ${settings.roots.length === 1 ? 'path' : 'paths'}${
      map.truncated ? ', truncated at the configured limit' : ''}`,
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
