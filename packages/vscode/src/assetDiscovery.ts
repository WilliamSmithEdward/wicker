import { AssetMap, assetMapperSettings, joinProjectPath, parseImportMap, objectOf, parseJsonLoosely,
  type AssetMapperSettings, type ConsoleRunner, type ImportMapEntry, type WickerFileSystem } from '@wicker/core';

export interface AssetDiscovery {
  /** Logical path to file, for `asset()` and bare imports. */
  readonly map: AssetMap;
  /** Entries of `importmap.php`, which is where a `#` alias is declared. */
  readonly importMap: readonly ImportMapEntry[];
  /**
   * Whether `importmap.php` was there to read. An absent file and a file
   * declaring nothing both produce no entries, and only one of them makes a
   * bare specifier worth reporting.
   */
  readonly importMapFound: boolean;
  /**
   * The project's own configuration file that names the service reading
   * `importmap.php`, when one does.
   *
   * The file is the whole import map only while Symfony's own reader reads
   * it. A project can replace or decorate that service and generate entries
   * that are never written to the file, and then a specifier missing from the
   * file says nothing about what the browser will be given.
   */
  readonly importMapReader?: string;
  readonly settings: AssetMapperSettings | undefined;
  readonly status: string;
}

/** The service that reads `importmap.php`. A project that names it has a say in what the import map holds. */
export const IMPORTMAP_READER = 'asset_mapper.importmap.config_reader';

const UNAVAILABLE: AssetDiscovery = {
  map: AssetMap.empty(), importMap: [], importMapFound: false, settings: undefined,
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
  const [source, importMapReader] = await Promise.all([
    fileSystem.readFile(joinProjectPath(root, 'importmap.php')), importMapReaderIn(fileSystem, root)]);
  const importMap = parseImportMap(source ?? '');
  const importMapFound = source !== undefined;
  const read = { importMap, importMapFound, ...(importMapReader === undefined ? {} : { importMapReader }) };
  if (!runner) {
    return { ...UNAVAILABLE, ...read };
  }

  const [config, directory] = await Promise.all([
    runner.run(['debug:config', 'framework', 'asset_mapper', '--format=json', '--no-ansi', '--no-interaction']),
    runner.run(['debug:container', '--parameter=kernel.project_dir', '--format=json', '--no-ansi', '--no-interaction']),
  ]);

  const runtimeRoot = directory.ok
    ? objectOf(parseJsonLoosely(directory.stdout))?.['kernel.project_dir']
    : undefined;
  if (!config.ok || typeof runtimeRoot !== 'string') {
    return { ...UNAVAILABLE, ...read, status: `unavailable; ${config.error ?? 'the project directory could not be read'}` };
  }

  const settings = assetMapperSettings(parseJsonLoosely(config.stdout), runtimeRoot);
  if (!settings) {
    return { ...UNAVAILABLE, ...read, status: 'unavailable; the asset mapper configuration could not be read' };
  }

  const map = await AssetMap.build(fileSystem, root, settings);
  return {
    map, ...read, settings,
    status: `${map.size} assets from ${settings.roots.length} configured ${settings.roots.length === 1 ? 'path' : 'paths'}${
      map.truncated ? ', truncated at the configured limit' : ''}`,
  };
}

const CONFIGURATION_FILE = /\.(?:ya?ml|php|xml)$/;

/**
 * The configuration file that names the importmap reader, if one does.
 *
 * Read from the project's own `config` tree, where a service is replaced or
 * decorated, a level at a time and bounded: the tree is small, and a project
 * large enough to exhaust the budget has not been shown to touch the service.
 * A mention is taken as having a say, whatever it turns out to do, because
 * the cost of being wrong is a check left unmade rather than a working import
 * reported as broken.
 */
async function importMapReaderIn(fileSystem: WickerFileSystem, root: string): Promise<string | undefined> {
  let budget = 300;
  let level = ['config'];
  for (let depth = 0; depth < 4 && level.length > 0 && budget > 0; depth++) {
    const next: string[] = [];
    for (const directory of level) {
      const entries = [...await fileSystem.readDirectory(joinProjectPath(root, directory))]
        .sort((left, right) => left.name.localeCompare(right.name));
      const files = entries.filter((entry) => entry.type === 'file' && CONFIGURATION_FILE.test(entry.name)).slice(0, budget);
      budget -= files.length;
      const sources = await Promise.all(files.map(async (entry) => {
        const path = `${directory}/${entry.name}`;
        return { path, source: await fileSystem.readFile(joinProjectPath(root, path)) };
      }));
      const naming = sources.find((file) => file.source?.includes(IMPORTMAP_READER));
      if (naming !== undefined) { return naming.path; }
      next.push(...entries.filter((entry) => entry.type === 'directory').map((entry) => `${directory}/${entry.name}`));
    }
    level = next;
  }
  return undefined;
}
