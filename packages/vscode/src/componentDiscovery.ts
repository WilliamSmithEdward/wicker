import { componentsFromDebug, joinProjectPath, parseComposerManifest,
  type ComposerManifest, type ConsoleRunner, type TwigComponent, type WickerFileSystem } from '@wicker/core';

export interface ComponentDiscovery {
  readonly components: readonly TwigComponent[];
  readonly manifest: ComposerManifest | undefined;
  readonly status: string;
}

export async function discoverComponents(fileSystem: WickerFileSystem, root: string,
  runner: ConsoleRunner | undefined): Promise<ComponentDiscovery> {
  // Re-read Composer: installing a bundle or changing PSR-4 must work without a reload.
  const manifest = parseComposerManifest(await fileSystem.readFile(joinProjectPath(root, 'composer.json')) ?? '');
  const installed = manifest?.requirements.has('symfony/ux-twig-component') || manifest?.requirements.has('symfony/ux-live-component') ||
    (await fileSystem.stat(joinProjectPath(root, 'vendor/symfony/ux-twig-component/composer.json')))?.type === 'file';
  const unavailable = (status: string): ComponentDiscovery => ({ components: [], manifest, status });
  if (!installed) { return unavailable('Twig Components not detected'); }
  if (!runner) { return unavailable('unavailable; console disabled or workspace untrusted'); }
  const result = await runner.run(['debug:twig-component', '--no-ansi', '--no-interaction']);
  if (!result.ok) { return unavailable(`unavailable; ${result.error ?? 'component discovery failed'}`); }
  const components = componentsFromDebug(result.stdout);
  return components === undefined ? unavailable('unavailable; component table was not readable')
    : { components, manifest, status: `${components.length} components from Symfony console` };
}
