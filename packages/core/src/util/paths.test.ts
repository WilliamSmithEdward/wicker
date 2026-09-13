import { describe, expect, it } from 'vitest';

import {
  ancestorDirectories,
  isWithinDirectory,
  joinProjectPath,
  normalizeProjectPath,
  normalizeRootPath,
  parentDirectory,
  projectPathBasename,
  projectPathDirname,
  toPosixPath,
  toProjectPath,
} from './paths.js';

describe('toPosixPath', () => {
  it('converts Windows separators', () => {
    expect(toPosixPath('F:\\GitHub\\wicker')).toBe('F:/GitHub/wicker');
  });

  it('leaves posix paths alone', () => {
    expect(toPosixPath('/app/templates')).toBe('/app/templates');
  });
});

describe('normalizeRootPath', () => {
  it.each([
    ['F:\\GitHub\\wicker', 'F:/GitHub/wicker'],
    ['F:/GitHub/wicker/', 'F:/GitHub/wicker'],
    ['/app/', '/app'],
    ['/app//templates', '/app/templates'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeRootPath(input)).toBe(expected);
  });

  it('keeps a bare posix root', () => {
    expect(normalizeRootPath('/')).toBe('/');
  });

  it('keeps a bare drive root', () => {
    expect(normalizeRootPath('F:/')).toBe('F:/');
    expect(normalizeRootPath('F:\\')).toBe('F:/');
  });

  it('preserves a UNC prefix, which a WSL project path depends on', () => {
    expect(normalizeRootPath('\\\\wsl.localhost\\Ubuntu\\home\\william\\projects\\symfonyApp')).toBe(
      '//wsl.localhost/Ubuntu/home/william/projects/symfonyApp',
    );
  });
});

describe('normalizeProjectPath', () => {
  it.each([
    ['templates/home/index.html.twig', 'templates/home/index.html.twig'],
    ['./templates/base.html.twig', 'templates/base.html.twig'],
    ['templates//home///a.twig', 'templates/home/a.twig'],
    ['templates\\home\\a.twig', 'templates/home/a.twig'],
    ['templates/home/../base.html.twig', 'templates/base.html.twig'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeProjectPath(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['/templates/a.twig', 'absolute posix'],
    ['F:/templates/a.twig', 'absolute windows'],
    ['../outside.twig', 'escapes the root'],
    ['templates/../../outside.twig', 'escapes via traversal'],
    ['.', 'resolves to nothing'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizeProjectPath(input)).toBeUndefined();
  });
});

describe('joinProjectPath', () => {
  it('joins a Windows root', () => {
    expect(joinProjectPath('F:\\GitHub\\app', 'templates/a.twig')).toBe(
      'F:/GitHub/app/templates/a.twig',
    );
  });

  it('joins a container root', () => {
    expect(joinProjectPath('/app', 'templates/a.twig')).toBe('/app/templates/a.twig');
  });

  it('does not double the slash at a drive root', () => {
    expect(joinProjectPath('F:/', 'templates/a.twig')).toBe('F:/templates/a.twig');
  });
});

describe('toProjectPath', () => {
  it('strips the root', () => {
    expect(toProjectPath('/app', '/app/templates/a.twig')).toBe('templates/a.twig');
  });

  it('handles mixed separators', () => {
    expect(toProjectPath('F:\\GitHub\\app', 'F:/GitHub/app/templates/a.twig')).toBe(
      'templates/a.twig',
    );
  });

  it('ignores drive-letter case, since Windows reaches one file both ways', () => {
    expect(toProjectPath('F:/GitHub/App', 'f:/github/app/templates/a.twig')).toBe(
      'templates/a.twig',
    );
  });

  it('stays case-sensitive on posix roots, where two such paths are two files', () => {
    expect(toProjectPath('/app', '/APP/templates/a.twig')).toBeUndefined();
  });

  it('returns undefined for the root itself', () => {
    expect(toProjectPath('/app', '/app')).toBeUndefined();
  });

  it('returns undefined for a sibling that merely shares a prefix', () => {
    expect(toProjectPath('/app', '/app-other/templates/a.twig')).toBeUndefined();
  });

  it('returns undefined for an unrelated path', () => {
    expect(toProjectPath('/app', '/srv/other/a.twig')).toBeUndefined();
  });
});

describe('projectPathDirname and projectPathBasename', () => {
  it('splits a nested path', () => {
    expect(projectPathDirname('templates/home/index.html.twig')).toBe('templates/home');
    expect(projectPathBasename('templates/home/index.html.twig')).toBe('index.html.twig');
  });

  it('reports no parent at the top level', () => {
    expect(projectPathDirname('composer.json')).toBeUndefined();
    expect(projectPathBasename('composer.json')).toBe('composer.json');
  });
});

describe('parentDirectory', () => {
  it.each([
    ['/app/templates/home', '/app/templates'],
    ['/app/templates', '/app'],
    ['/app', '/'],
    ['F:/GitHub/wicker/packages', 'F:/GitHub/wicker'],
    ['F:/GitHub', 'F:/'],
    ['F:\\GitHub\\wicker\\', 'F:/GitHub'],
    ['//wsl.localhost/Ubuntu/home/william', '//wsl.localhost/Ubuntu/home'],
  ])('%s -> %s', (input, expected) => {
    expect(parentDirectory(input)).toBe(expected);
  });

  it.each([
    ['/', 'the posix root'],
    ['F:/', 'a drive root'],
    ['//wsl.localhost/Ubuntu', 'a UNC share root'],
  ])('stops at %s (%s)', (input) => {
    expect(parentDirectory(input)).toBeUndefined();
  });
});

describe('ancestorDirectories', () => {
  it('walks upward, nearest first, and terminates at the root', () => {
    expect(ancestorDirectories('/app/templates/home/index.html.twig')).toEqual([
      '/app/templates/home',
      '/app/templates',
      '/app',
      '/',
    ]);
  });

  it('terminates at a drive root', () => {
    expect(ancestorDirectories('F:/GitHub/wicker/package.json')).toEqual([
      'F:/GitHub/wicker',
      'F:/GitHub',
      'F:/',
    ]);
  });

  it('is empty at a root', () => {
    expect(ancestorDirectories('/')).toEqual([]);
  });
});

describe('isWithinDirectory', () => {
  it('matches the directory itself and its descendants', () => {
    expect(isWithinDirectory('templates', 'templates')).toBe(true);
    expect(isWithinDirectory('templates/home/a.twig', 'templates')).toBe(true);
  });

  it('does not match a sibling sharing a prefix', () => {
    expect(isWithinDirectory('templates2/a.twig', 'templates')).toBe(false);
  });

  it('does not match an unrelated path', () => {
    expect(isWithinDirectory('src/Controller/X.php', 'templates')).toBe(false);
  });
});
