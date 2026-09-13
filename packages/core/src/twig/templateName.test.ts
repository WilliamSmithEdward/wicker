import { describe, expect, it } from 'vitest';

import {
  formatTemplateName,
  normalizeLoaderNamespaceKey,
  parseTemplateName,
  type TwigTemplateName,
} from './templateName.js';

function parsed(raw: string): TwigTemplateName {
  const result = parseTemplateName(raw);
  if (!result.ok) {
    throw new Error(`expected "${raw}" to parse, got ${result.problem.kind}`);
  }
  return result.value;
}

function problemKind(raw: string): string {
  const result = parseTemplateName(raw);
  if (result.ok) {
    throw new Error(`expected "${raw}" to fail, but it parsed`);
  }
  return result.problem.kind;
}

describe('parseTemplateName', () => {
  it('reads a main-namespace template', () => {
    expect(parsed('home/index.html.twig')).toEqual({
      raw: 'home/index.html.twig',
      namespace: null,
      path: 'home/index.html.twig',
      forcesBundleTemplate: false,
    });
  });

  it('reads a template at the root of the main namespace', () => {
    expect(parsed('base.html.twig').path).toBe('base.html.twig');
    expect(parsed('base.html.twig').namespace).toBeNull();
  });

  it('reads a namespaced template', () => {
    expect(parsed('@Maker/foo.html.twig')).toEqual({
      raw: '@Maker/foo.html.twig',
      namespace: 'Maker',
      path: 'foo.html.twig',
      forcesBundleTemplate: false,
    });
  });

  it('reads the bundle-override form', () => {
    expect(parsed('@!Maker/foo.html.twig')).toEqual({
      raw: '@!Maker/foo.html.twig',
      namespace: 'Maker',
      path: 'foo.html.twig',
      forcesBundleTemplate: true,
    });
  });

  it('keeps nested paths below a namespace intact', () => {
    expect(parsed('@Admin/user/list/table.html.twig').path).toBe('user/list/table.html.twig');
  });

  it('accepts names that are not .twig files, because Twig does not require it', () => {
    expect(parsed('mail/welcome.txt.twig').path).toBe('mail/welcome.txt.twig');
    expect(parsed('robots.txt').path).toBe('robots.txt');
  });

  it('does not trim, because surrounding whitespace changes the lookup', () => {
    expect(parsed(' home/index.html.twig').path).toBe(' home/index.html.twig');
  });

  describe('rejects', () => {
    it.each([
      ['', 'empty'],
      ['@', 'namespace-without-path'],
      ['@Maker', 'namespace-without-path'],
      ['@Maker/', 'namespace-without-path'],
      ['@/foo.html.twig', 'empty-namespace'],
      ['home\\index.html.twig', 'backslash-separator'],
      ['/home/index.html.twig', 'absolute-path'],
      ['../secrets.html.twig', 'parent-traversal'],
      ['home/../../etc/passwd', 'parent-traversal'],
      ['AcmeBundle:Default:index.html.twig', 'legacy-bundle-syntax'],
    ])('%s as %s', (raw, kind) => {
      expect(problemKind(raw)).toBe(kind);
    });
  });
});

describe('formatTemplateName', () => {
  it('round-trips every form', () => {
    for (const raw of [
      'home/index.html.twig',
      'base.html.twig',
      '@Maker/foo.html.twig',
      '@!Maker/foo.html.twig',
      '@Admin/user/list/table.html.twig',
    ]) {
      expect(formatTemplateName(parsed(raw))).toBe(raw);
    }
  });
});

describe('normalizeLoaderNamespaceKey', () => {
  it('maps the (None) label to the main namespace', () => {
    expect(normalizeLoaderNamespaceKey('(None)')).toEqual({
      namespace: null,
      forcesBundleTemplate: false,
    });
  });

  it('strips the @ sigil', () => {
    expect(normalizeLoaderNamespaceKey('@Maker')).toEqual({
      namespace: 'Maker',
      forcesBundleTemplate: false,
    });
  });

  it('recognises the @! override key', () => {
    expect(normalizeLoaderNamespaceKey('@!Maker')).toEqual({
      namespace: 'Maker',
      forcesBundleTemplate: true,
    });
  });

  it('accepts a bare key, as twig.yaml paths are written without sigils', () => {
    expect(normalizeLoaderNamespaceKey('Admin')).toEqual({
      namespace: 'Admin',
      forcesBundleTemplate: false,
    });
  });
});
