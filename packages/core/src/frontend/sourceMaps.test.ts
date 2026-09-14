import { describe, expect, test } from 'vitest';
import { typescriptSourceForJavascript } from './sourceMaps.js';
import { FrontendIndex } from './index.js';

const map = (sources: string[], extra = {}): string => JSON.stringify({ version: 3, sources, names: [], mappings: '', ...extra });
describe('TypeScript source preference', () => {
  test('follows a local map and sourceRoot to an existing TS file', () => {
    const files: Record<string, string> = {
      'assets/build/controller.js.map': map(['controller.ts'], { sourceRoot: '../src' }),
      'assets/src/controller.ts': 'export default class {}',
    };
    expect(typescriptSourceForJavascript('assets/build/controller.js', 'run();\n//# sourceMappingURL=controller.js.map', (path) => files[path]))
      .toBe('assets/src/controller.ts');
  });
  test('supports inline maps and files in the project root', () => {
    const data = Buffer.from(map(['controller.ts'])).toString('base64');
    expect(typescriptSourceForJavascript('controller.js', `/*# sourceMappingURL=data:application/json;base64,${data} */`,
      (path) => path === 'controller.ts' ? '' : undefined)).toBe('controller.ts');
  });
  test('does not confuse strings with map comments and respects the last annotation', () => {
    const files: Record<string, string> = { 'a.map': map(['a.ts']), 'a.ts': '' };
    const read = (path: string): string | undefined => files[path];
    expect(typescriptSourceForJavascript('a.js', '`\n//# sourceMappingURL=a.map\n`', read)).toBeUndefined();
    expect(typescriptSourceForJavascript('a.js', '// text containing sourceMappingURL=a.map', read)).toBeUndefined();
    expect(typescriptSourceForJavascript('a.js', '//# sourceMappingURL=missing.map\n//# sourceMappingURL=a.map', read)).toBe('a.ts');
  });
  test('keeps independent siblings, bundles, missing targets and malformed maps as JavaScript', () => {
    for (const raw of [map(['a.ts', 'b.ts']), map(['missing.ts']), map(['a.js']), map(['a.d.ts']), map(['a.ts'], { sections: [] }), '{}', '{bad']) {
      const files: Record<string, string> = { 'a.map': raw, 'a.ts': '', 'a.js': '', 'a.d.ts': '' };
      expect(typescriptSourceForJavascript('a.js', '//# sourceMappingURL=a.map', (path) => files[path])).toBeUndefined();
    }
    expect(typescriptSourceForJavascript('a.js', 'run();', (path) => path === 'a.ts' ? '' : undefined)).toBeUndefined();
  });
  test('never reads external or escaping paths', () => {
    const requested: string[] = [];
    const read = (path: string): string | undefined => { requested.push(path); return map(['../../private.ts']); };
    for (const reference of ['https://example.com/a.map', '//example.com/a.map', '../a.map', '/a.map']) {
      expect(typescriptSourceForJavascript('a.js', `//# sourceMappingURL=${reference}`, read)).toBeUndefined();
    }
    expect(requested).toEqual([]);
    expect(typescriptSourceForJavascript('a.js', '//# sourceMappingURL=a.map', read)).toBeUndefined();
    expect(requested).toEqual(['a.map']);
  });
});

test('script associations cannot follow fake includes inside comments or verbatim Twig', () => {
  const index = new FrontendIndex();
  index.update('page.html.twig', `{# {% include 'comment.twig' %} #}
{% verbatim %}{% include 'example.twig' %}{% endverbatim %}
{% include 'real.twig' %}`);
  expect(index.get('page.html.twig')!.templateReferences.map((ref) => ref.templateName)).toEqual(['real.twig']);
});
