import { describe, expect, it } from 'vitest';

import { routeFolderOf, routeLeafName, routeLevel } from './routeTree.js';

const routes = [
  { name: 'home', path: '/' },
  { name: 'health', path: '/api/health' },
  { name: 'items', path: '/api/v1/items' },
  { name: 'item', path: '/api/v1/items/{id}' },
  { name: 'item_comments', path: '/api/v1/items/{id}/comments' },
  { name: 'endpoint', path: '/api/v1/test/test-endpoint' },
];
const names = (level: { routes: readonly { name: string }[] }): string[] => level.routes.map((route) => route.name);

describe('the API route hierarchy', () => {
  it('opens on the first segment, with the route at the top beside it', () => {
    const top = routeLevel(routes, '');
    expect(top.folders).toEqual([{ name: 'api', path: 'api', count: 5 }]);
    expect(names(top)).toEqual(['home']);
  });

  it('walks a path a segment at a time: api, v1, test, test-endpoint', () => {
    expect(routeLevel(routes, 'api').folders).toEqual([{ name: 'v1', path: 'api/v1', count: 4 }]);
    expect(names(routeLevel(routes, 'api'))).toEqual(['health']);
    expect(routeLevel(routes, 'api/v1').folders.map((folder) => folder.name)).toEqual(['items', 'test']);
    expect(names(routeLevel(routes, 'api/v1/test'))).toEqual(['endpoint']);
  });

  it('keeps a route beside the folder of the routes beneath it, not inside it', () => {
    const v1 = routeLevel(routes, 'api/v1');
    expect(names(v1)).toEqual(['items']);
    expect(v1.folders.find((folder) => folder.name === 'items')).toEqual({ name: 'items', path: 'api/v1/items', count: 2 });
    // A placeholder is a segment like any other.
    expect(routeLevel(routes, 'api/v1/items').folders).toEqual([{ name: '{id}', path: 'api/v1/items/{id}', count: 1 }]);
    expect(names(routeLevel(routes, 'api/v1/items'))).toEqual(['item']);
  });

  it('does not take a folder for one that only starts the same way', () => {
    expect(names(routeLevel([{ name: 'other', path: '/api/v10/items' }], 'api/v1'))).toEqual([]);
  });

  it('names a row by its last segment and finds the folder it is a leaf of', () => {
    expect(routeLeafName('/api/v1/test/test-endpoint')).toBe('test-endpoint');
    expect(routeLeafName('/')).toBe('/');
    expect(routeFolderOf('/api/v1/test/test-endpoint')).toBe('api/v1/test');
    expect(routeFolderOf('api/v1')).toBe('api');
    expect(routeFolderOf('/health')).toBe('');
  });
});
