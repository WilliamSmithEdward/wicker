import { describe, expect, it } from 'vitest';

import { directoryExists, fileExists } from './fileSystem.js';
import { InMemoryFileSystem } from './inMemoryFileSystem.js';

function sortedNames(entries: readonly { name: string; type: string }[]): string[] {
  return entries.map((e) => `${e.type}:${e.name}`).sort();
}

describe('InMemoryFileSystem', () => {
  const fileSystem = new InMemoryFileSystem({
    '/app/composer.json': '{"name":"symfony/skeleton"}',
    '/app/bin/console': '#!/usr/bin/env php',
    '/app/templates/base.html.twig': 'base',
    '/app/templates/home/index.html.twig': 'index',
    '/app/src/Controller/HomeController.php': '<?php',
  });

  it('reads a file it was seeded with', async () => {
    await expect(fileSystem.readFile('/app/templates/base.html.twig')).resolves.toBe('base');
  });

  it('returns undefined for a missing file', async () => {
    await expect(fileSystem.readFile('/app/nope.twig')).resolves.toBeUndefined();
  });

  it('returns undefined when reading a directory as a file', async () => {
    await expect(fileSystem.readFile('/app/templates')).resolves.toBeUndefined();
  });

  it('stats files and implied directories', async () => {
    await expect(fileSystem.stat('/app/composer.json')).resolves.toEqual({ type: 'file' });
    await expect(fileSystem.stat('/app/templates')).resolves.toEqual({ type: 'directory' });
    await expect(fileSystem.stat('/app/templates/home')).resolves.toEqual({ type: 'directory' });
    await expect(fileSystem.stat('/app')).resolves.toEqual({ type: 'directory' });
    await expect(fileSystem.stat('/app/missing')).resolves.toBeUndefined();
  });

  it('normalises separators and trailing slashes on lookup', async () => {
    await expect(fileSystem.readFile('\\app\\templates\\base.html.twig')).resolves.toBe('base');
    await expect(fileSystem.stat('/app/templates/')).resolves.toEqual({ type: 'directory' });
  });

  it('lists only immediate children', async () => {
    expect(sortedNames(await fileSystem.readDirectory('/app'))).toEqual([
      'directory:bin',
      'directory:src',
      'directory:templates',
      'file:composer.json',
    ]);
    expect(sortedNames(await fileSystem.readDirectory('/app/templates'))).toEqual([
      'directory:home',
      'file:base.html.twig',
    ]);
  });

  it('returns an empty listing for a file or a missing path', async () => {
    expect(await fileSystem.readDirectory('/app/composer.json')).toEqual([]);
    expect(await fileSystem.readDirectory('/app/missing')).toEqual([]);
  });

  it('supports an explicitly empty directory', async () => {
    const empty = new InMemoryFileSystem();
    empty.makeDirectory('/app/templates');
    await expect(directoryExists(empty, '/app/templates')).resolves.toBe(true);
    expect(await empty.readDirectory('/app/templates')).toEqual([]);
  });

  it('creates parent directories when a file is written', async () => {
    const written = new InMemoryFileSystem();
    written.writeFile('/app/a/b/c.twig', 'x');
    await expect(directoryExists(written, '/app/a')).resolves.toBe(true);
    await expect(directoryExists(written, '/app/a/b')).resolves.toBe(true);
    await expect(fileExists(written, '/app/a/b/c.twig')).resolves.toBe(true);
  });

  it('deletes files', async () => {
    const mutable = new InMemoryFileSystem({ '/app/a.twig': 'x' });
    expect(mutable.deleteFile('/app/a.twig')).toBe(true);
    expect(mutable.deleteFile('/app/a.twig')).toBe(false);
    await expect(fileExists(mutable, '/app/a.twig')).resolves.toBe(false);
  });

  describe('path case handling', () => {
    it('treats Windows drive paths case-insensitively', async () => {
      const windows = new InMemoryFileSystem({ 'F:/GitHub/App/templates/a.twig': 'x' });
      await expect(windows.readFile('f:/github/app/templates/a.twig')).resolves.toBe('x');
      await expect(directoryExists(windows, 'F:/github/APP/templates')).resolves.toBe(true);
    });

    it('treats posix paths case-sensitively, because they name different files', async () => {
      const posix = new InMemoryFileSystem({ '/app/templates/a.twig': 'x' });
      await expect(posix.readFile('/APP/templates/a.twig')).resolves.toBeUndefined();
    });

    it('walks up to a drive root without looping', async () => {
      const windows = new InMemoryFileSystem({ 'F:/a.twig': 'x' });
      await expect(directoryExists(windows, 'F:/')).resolves.toBe(true);
    });
  });
});
