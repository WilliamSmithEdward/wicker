import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem, type ConsoleRunner } from '@wicker/core';
import { discoverFrontend } from './frontendDiscovery.js';

const root = 'F:/app';
const files = {
  [`${root}/composer.json`]: '{"require":{"symfony/stimulus-bundle":"^3.4"}}',
  [`${root}/assets/controllers/admin/user_card_controller.ts`]: 'export default class {}',
  [`${root}/assets/controllers/admin/user_card_controller.js`]: 'export default class {}',
  [`${root}/assets/controllers/status-controller.js`]: 'export default class {}',
  [`${root}/assets/controllers/helper.js`]: '',
  [`${root}/assets/controllers.json`]: JSON.stringify({ controllers: { '@symfony/ux-example': { example: { enabled: true }, disabled: { enabled: false } } } }),
  [`${root}/vendor/symfony/ux-example/assets/package.json`]: JSON.stringify({ symfony: { controllers: { example: { main: 'example.js' }, disabled: { main: 'disabled.js' } } } }),
  [`${root}/vendor/symfony/ux-example/assets/example.js`]: '',
  [`${root}/vendor/symfony/ux-example/assets/disabled.js`]: '',
};
function runner(paths: unknown = ['/app/assets/controllers']): ConsoleRunner {
  return { run: (args) => Promise.resolve({ ok: true, error: undefined, stdout: JSON.stringify(args[0] === 'debug:router' ? {
    api: { path: '/api', method: 'GET', defaults: { _controller: 'App\\Controller\\ApiController::index' } },
  } : args[0] === 'debug:config' ? { stimulus: { controller_paths: paths, controllers_json: '/app/assets/controllers.json' } } : { 'kernel.project_dir': '/app' }) }) };
}
describe('frontend discovery', () => {
  it('maps container paths, JS-over-TS precedence and enabled UX metadata', async () => {
    const discovered = await discoverFrontend(new InMemoryFileSystem(files), root, runner());
    expect(discovered.controllers).toEqual([
      { name: 'admin--user-card', projectPath: 'assets/controllers/admin/user_card_controller.js' },
      { name: 'status', projectPath: 'assets/controllers/status-controller.js' },
      { name: 'symfony--ux-example--example', projectPath: 'vendor/symfony/ux-example/assets/example.js' },
    ]);
    expect(discovered.routes[0]?.name).toBe('api');
  });
  it('does not index paths outside the runtime project', async () => {
    const discovered = await discoverFrontend(new InMemoryFileSystem(files), root, runner(['/outside/controllers', '../../outside']));
    expect(discovered.controllers.map((entry) => entry.name)).toEqual(['symfony--ux-example--example']);
  });
  it('fails quietly with unavailable or malformed console output', async () => {
    const fs = new InMemoryFileSystem(files);
    expect((await discoverFrontend(fs, root, undefined)).controllers).toEqual([]);
    const result = await discoverFrontend(fs, root, { run: () => Promise.resolve({ ok: true, error: undefined, stdout: '{"unexpected": true}' }) });
    expect(result.controllers).toEqual([]);
    expect(result.routes).toEqual([]);
  });
});
