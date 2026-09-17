import { describe, expect, it } from 'vitest';

import { commonPrefix, leafName, parentPath, pathLevel } from './pathTree.js';

const routes = [
  { name: 'home', path: '/' },
  { name: 'health', path: '/api/health' },
  { name: 'items', path: '/api/v1/items' },
  { name: 'item', path: '/api/v1/items/{id}' },
  { name: 'item_comments', path: '/api/v1/items/{id}/comments' },
  { name: 'endpoint', path: '/api/v1/test/test-endpoint' },
];
const names = (level: { leaves: readonly { name: string }[] }): string[] => level.leaves.map((entry) => entry.name);

describe('grouping a list by path', () => {
  it('opens on the first segment, with the entry at the top beside it', () => {
    const top = pathLevel(routes, '');
    expect(top.folders).toEqual([{ name: 'api', path: 'api', count: 5 }]);
    expect(names(top)).toEqual(['home']);
  });

  it('walks a path a segment at a time: api, v1, test, test-endpoint', () => {
    expect(pathLevel(routes, 'api').folders).toEqual([{ name: 'v1', path: 'api/v1', count: 4 }]);
    expect(names(pathLevel(routes, 'api'))).toEqual(['health']);
    expect(pathLevel(routes, 'api/v1').folders.map((folder) => folder.name)).toEqual(['items', 'test']);
    expect(names(pathLevel(routes, 'api/v1/test'))).toEqual(['endpoint']);
  });

  it('keeps an entry beside the folder of the entries beneath it, not inside it', () => {
    const v1 = pathLevel(routes, 'api/v1');
    expect(names(v1)).toEqual(['items']);
    expect(v1.folders.find((folder) => folder.name === 'items')).toEqual({ name: 'items', path: 'api/v1/items', count: 2 });
    // A placeholder is a segment like any other.
    expect(pathLevel(routes, 'api/v1/items').folders).toEqual([{ name: '{id}', path: 'api/v1/items/{id}', count: 1 }]);
    expect(names(pathLevel(routes, 'api/v1/items'))).toEqual(['item']);
  });

  it('does not take a folder for one that only starts the same way', () => {
    expect(names(pathLevel([{ name: 'other', path: '/api/v10/items' }], 'api/v1'))).toEqual([]);
  });

  it('names a row by its last segment and finds the folder it is a leaf of', () => {
    expect(leafName('/api/v1/test/test-endpoint')).toBe('test-endpoint');
    expect(leafName('/')).toBe('/');
    expect(parentPath('/api/v1/test/test-endpoint')).toBe('api/v1/test');
    expect(parentPath('api/v1')).toBe('api');
    expect(parentPath('/health')).toBe('');
  });

  /*
   * Controllers nearly always share a namespace, and folding it away is what
   * keeps a project with one namespace looking exactly as it did.
   */
  describe('the head every path shares', () => {
    it('is everything above the deepest entry they have in common', () => {
      expect(commonPrefix(['App/Controller/TaskController', 'App/Controller/Admin/UserController']))
        .toEqual(['App', 'Controller']);
      expect(commonPrefix(['App/Controller/Api/V1/ItemController', 'App/Controller/Api/V1/TagController']))
        .toEqual(['App', 'Controller', 'Api', 'V1']);
    });

    it('never swallows the name an entry ends with, so every row keeps one', () => {
      expect(commonPrefix(['App/Controller/TaskController', 'App/Controller/PageController'])).toEqual(['App', 'Controller']);
      expect(commonPrefix(['TaskController'])).toEqual([]);
    });

    it('is empty where the paths share nothing', () => {
      expect(commonPrefix(['App/Controller/TaskController', 'Admin/Controller/UserController'])).toEqual([]);
      expect(commonPrefix([])).toEqual([]);
    });
  });
});
