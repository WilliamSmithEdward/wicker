import { joinProjectPath, normalizeProjectPath, parseComposerManifest, parseJsonLoosely, routesFromDebug,
  stimulusIdentifier, toProjectPath, type ConsoleRunner, type StimulusController, type SymfonyRoute, type WickerFileSystem } from '@wicker/core';

export interface FrontendDiscovery {
  readonly controllers: readonly StimulusController[];
  /**
   * Where a new controller belongs, from `stimulus.controller_paths`.
   *
   * The first configured directory, which is the one a project keeps its own
   * controllers in. Absent when the console could not say, in which case
   * nothing should guess at a location.
   */
  readonly controllerDirectory?: string;
  readonly routes: readonly SymfonyRoute[];
  readonly stimulusStatus: string;
  readonly routesStatus: string;
}
export async function discoverFrontend(fs: WickerFileSystem, root: string, runner: ConsoleRunner | undefined): Promise<FrontendDiscovery> {
  const unavailable: FrontendDiscovery = { controllers: [], routes: [], stimulusStatus: 'unavailable; console required', routesStatus: 'unavailable; console required' };
  if (!runner) { return unavailable; }
  const manifest = parseComposerManifest(await fs.readFile(joinProjectPath(root, 'composer.json')) ?? '');
  const installed = manifest?.requirements.has('symfony/stimulus-bundle') ||
    (await fs.stat(joinProjectPath(root, 'vendor/symfony/stimulus-bundle/composer.json')))?.type === 'file';
  const [routeResult, stimulus] = await Promise.all([
    runner.run(['debug:router', '--format=json', '--no-ansi', '--no-interaction']),
    installed ? discoverStimulus(fs, root, runner) : Promise.resolve({ controllers: [], status: 'StimulusBundle not detected', directory: undefined }),
  ]);
  const routes = routeResult.ok ? routesFromDebug(routeResult.stdout) : undefined;
  return { controllers: stimulus.controllers, stimulusStatus: stimulus.status, routes: routes ?? [],
    ...(stimulus.directory === undefined ? {} : { controllerDirectory: stimulus.directory }),
    routesStatus: routes ? `${routes.length} routes from Symfony console` : `unavailable; ${routeResult.error ?? 'route JSON was not readable'}` };
}

async function discoverStimulus(fs: WickerFileSystem, root: string, runner: ConsoleRunner): Promise<{ controllers: StimulusController[]; status: string; directory: string | undefined }> {
  const [config, directory] = await Promise.all([
    runner.run(['debug:config', 'stimulus', '--format=json', '--no-ansi', '--no-interaction']),
    runner.run(['debug:container', '--parameter=kernel.project_dir', '--format=json', '--no-ansi', '--no-interaction']),
  ]);
  const data = config.ok ? object(parseJsonLoosely(config.stdout)) : undefined;
  const stimulus = object(data?.['stimulus']);
  const runtimeRoot = directory.ok ? object(parseJsonLoosely(directory.stdout))?.['kernel.project_dir'] : undefined;
  if (!stimulus || typeof runtimeRoot !== 'string' || !Array.isArray(stimulus['controller_paths'])) {
    return { controllers: [], status: 'unavailable; Stimulus configuration could not be read', directory: undefined };
  }
  const projectPath = (value: unknown): string | undefined => typeof value === 'string'
    ? toProjectPath(runtimeRoot, value) ?? normalizeProjectPath(value) : undefined;
  const controllers = new Map<string, StimulusController>();
  const jsonPath = projectPath(stimulus['controllers_json']);
  if (jsonPath) {
    const json = object(parseJsonLoosely(await fs.readFile(joinProjectPath(root, jsonPath)) ?? ''));
    for (const [packageName, packageControllers] of Object.entries(object(json?.['controllers']) ?? {})) {
      if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/i.test(packageName)) { continue; }
      // StimulusBundle reads the package's own metadata, not a hard-coded UX catalog.
      for (const directory of [`vendor/${packageName.slice(1)}/assets`, `vendor/${packageName.slice(1)}/Resources/assets`, `node_modules/${packageName}`]) {
        const metadata = object(parseJsonLoosely(await fs.readFile(joinProjectPath(root, `${directory}/package.json`)) ?? ''));
        if (!metadata) { continue; }
        const registrations = object(object(metadata['symfony'])?.['controllers']);
        for (const [key, value] of Object.entries(object(packageControllers) ?? {})) {
          const settings = object(value), registration = object(registrations?.[key]);
          if (settings?.['enabled'] !== true || !registration) { continue; }
          const main = typeof registration['main'] === 'string' ? normalizeProjectPath(`${directory}/${registration['main']}`) : undefined;
          const override = settings['name'] ?? registration['name'];
          const name = typeof override === 'string' ? override.replaceAll('/', '--') : `${packageName.slice(1)}/${key}`.replaceAll('_', '-').replaceAll('/', '--');
          if (main && /^[\w-]+$/.test(name) && (await fs.stat(joinProjectPath(root, main)))?.type === 'file') {
            controllers.set(name, { name, projectPath: main });
          }
        }
        break;
      }
    }
  }
  let seen = 0, truncated = false;
  for (const configured of stimulus['controller_paths']) {
    const path = projectPath(configured);
    if (!path) { continue; }
    const visit = async (directory: string): Promise<void> => {
      const entries = [...await fs.readDirectory(joinProjectPath(root, directory))].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++seen > 20000) { truncated = true; return; }
        const child = `${directory}/${entry.name}`;
        if (entry.type === 'directory' && !['node_modules', '.git'].includes(entry.name)) { await visit(child); }
        else if (entry.type === 'file') {
          const name = stimulusIdentifier(child.slice(path.length + 1));
          if (name && !(child.endsWith('.ts') && (await fs.stat(joinProjectPath(root, child.slice(0, -3) + '.js')))?.type === 'file')) {
            controllers.set(name, { name, projectPath: child });
          }
        }
      }
    };
    await visit(path);
  }
  return { controllers: [...controllers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    status: `Stimulus configuration from Symfony console${truncated ? '; controller scan limit reached' : ''}`,
    // The first configured path, which is where a project keeps its own
    // controllers. A later one is usually a bundle's.
    directory: projectPath(stimulus['controller_paths'][0]) };
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
