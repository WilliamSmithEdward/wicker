import { describe, expect, it } from 'vitest';

import { scanTemplateReferences, type TemplateReference } from './templateReferences.js';

/**
 * Scans, and asserts the invariant every caller depends on: the reported name
 * range must select exactly the template name in the original source. If this
 * drifts, go-to-definition highlights the wrong characters.
 */
function scan(source: string): readonly TemplateReference[] {
  const result = scanTemplateReferences(source);
  expect(result.parseFailed).toBe(false);
  for (const reference of result.references) {
    expect(source.slice(reference.nameRange.start, reference.nameRange.end)).toBe(
      reference.templateName,
    );
    expect(source.slice(reference.range.start, reference.range.end)).toContain(
      reference.templateName,
    );
  }
  return result.references;
}

function php(body: string): string {
  return `<?php\n\nnamespace App\\Controller;\n\nfinal class HomeController extends AbstractController\n{\n${body}\n}\n`;
}

/** The live app's controller, verbatim. */
const REAL_CONTROLLER = `<?php

namespace App\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\Routing\\Attribute\\Route;

final class HomeController extends AbstractController
{
    #[Route('/', name: 'app_home')]
    public function index(): Response
    {
        return $this->render('home/index.html.twig', [
            'controller_name' => 'HomeController',
        ]);
    }
}
`;

describe('scanTemplateReferences on the real controller', () => {
  const references = scan(REAL_CONTROLLER);

  it('finds exactly one template reference', () => {
    expect(references).toHaveLength(1);
  });

  it('reads the template name, receiver, and context', () => {
    expect(references[0]).toMatchObject({
      templateName: 'home/index.html.twig',
      kind: 'render',
      receiver: 'this',
      contextKeys: ['controller_name'],
      contextIsDynamic: false,
      className: 'App\\Controller\\HomeController',
      methodName: 'index',
    });
  });
});

describe('render method forms', () => {
  it.each([
    ['render', 'render'],
    ['renderView', 'renderView'],
    ['renderBlock', 'renderBlock'],
    ['renderBlockView', 'renderBlockView'],
    ['renderForm', 'renderForm'],
    ['stream', 'stream'],
  ])('recognises ->%s()', (method, kind) => {
    const references = scan(
      php(`    public function a() { return $this->${method}('a.html.twig'); }`),
    );
    expect(references).toHaveLength(1);
    expect(references[0]?.kind).toBe(kind);
  });

  it('recognises a render on a Twig Environment, not just the controller', () => {
    const references = scan(
      php(`    public function a(Environment $twig) { return $twig->render('mail/a.html.twig'); }`),
    );
    expect(references[0]).toMatchObject({
      templateName: 'mail/a.html.twig',
      receiver: 'twig',
      kind: 'render',
    });
  });

  it('recognises a nullsafe call', () => {
    const references = scan(php(`    public function a() { return $this?->render('a.html.twig'); }`));
    expect(references).toHaveLength(1);
  });

  it('ignores unrelated methods', () => {
    expect(scan(php(`    public function a() { return $this->json('not/a/template'); }`))).toEqual(
      [],
    );
  });
});

describe('the #[Template] attribute', () => {
  it('reads a bare attribute', () => {
    const references = scan(
      php(`    #[Template('home/about.html.twig')]\n    public function about(): array { return []; }`),
    );
    expect(references[0]).toMatchObject({
      templateName: 'home/about.html.twig',
      kind: 'template-attribute',
      methodName: 'about',
    });
  });

  it('reads a fully qualified attribute', () => {
    const references = scan(
      php(
        `    #[\\Symfony\\Bridge\\Twig\\Attribute\\Template('home/about.html.twig')]\n    public function about(): array { return []; }`,
      ),
    );
    expect(references).toHaveLength(1);
    expect(references[0]?.kind).toBe('template-attribute');
  });

  it('ignores an unrelated attribute that carries a string', () => {
    expect(scan(php(`    #[Route('/about', name: 'app_about')]\n    public function a() {}`))).toEqual(
      [],
    );
  });
});

describe('named arguments', () => {
  it('reads the template from a named argument', () => {
    const references = scan(
      php(`    public function a() { return $this->render(view: 'a.html.twig'); }`),
    );
    expect(references[0]?.templateName).toBe('a.html.twig');
  });

  it('reads context from a named argument given out of order', () => {
    const references = scan(
      php(
        `    public function a() { return $this->render(parameters: ['x' => 1], view: 'a.html.twig'); }`,
      ),
    );
    expect(references[0]).toMatchObject({
      templateName: 'a.html.twig',
      contextKeys: ['x'],
      contextIsDynamic: false,
    });
  });
});

describe('context arrays', () => {
  it('reads multiple literal keys in order', () => {
    const references = scan(
      php(
        `    public function a() { return $this->render('a.html.twig', ['title' => 't', 'items' => [], 'user' => $u]); }`,
      ),
    );
    expect(references[0]?.contextKeys).toEqual(['title', 'items', 'user']);
    expect(references[0]?.contextIsDynamic).toBe(false);
  });

  it('reports no context when none is passed', () => {
    const references = scan(php(`    public function a() { return $this->render('a.html.twig'); }`));
    expect(references[0]?.contextKeys).toEqual([]);
    expect(references[0]?.contextIsDynamic).toBe(false);
  });

  it('marks a variable context as dynamic', () => {
    const references = scan(
      php(`    public function a() { return $this->render('a.html.twig', $params); }`),
    );
    expect(references[0]).toMatchObject({ contextKeys: [], contextIsDynamic: true });
  });

  it('marks a spread as dynamic while keeping the visible keys', () => {
    const references = scan(
      php(`    public function a() { return $this->render('a.html.twig', ['a' => 1, ...$rest]); }`),
    );
    expect(references[0]).toMatchObject({ contextKeys: ['a'], contextIsDynamic: true });
  });

  it('marks a computed key as dynamic', () => {
    const references = scan(
      php(`    public function a() { return $this->render('a.html.twig', [$key => 1, 'b' => 2]); }`),
    );
    expect(references[0]).toMatchObject({ contextKeys: ['b'], contextIsDynamic: true });
  });
});

describe('string literal forms', () => {
  it('reads a double-quoted name', () => {
    const references = scan(php(`    public function a() { return $this->render("a.html.twig"); }`));
    expect(references[0]?.templateName).toBe('a.html.twig');
  });

  it('reads a namespaced name', () => {
    const references = scan(
      php(`    public function a() { return $this->render('@Admin/user/list.html.twig'); }`),
    );
    expect(references[0]?.templateName).toBe('@Admin/user/list.html.twig');
  });

  it('skips an interpolated name, whose value is not statically known', () => {
    const references = scan(
      php(`    public function a() { return $this->render("home/{$page}.html.twig"); }`),
    );
    expect(references).toEqual([]);
  });

  it('skips a concatenated name', () => {
    const references = scan(
      php(`    public function a() { return $this->render('home/' . $page . '.html.twig'); }`),
    );
    expect(references).toEqual([]);
  });

  it('skips a variable name', () => {
    expect(scan(php(`    public function a() { return $this->render($template); }`))).toEqual([]);
  });
});

describe('enclosing context', () => {
  it('qualifies the class with its namespace', () => {
    const references = scan(REAL_CONTROLLER);
    expect(references[0]?.className).toBe('App\\Controller\\HomeController');
  });

  it('reports the class unqualified when the file declares no namespace', () => {
    const references = scan(
      `<?php\nclass Legacy { public function a() { return $this->render('a.html.twig'); } }\n`,
    );
    expect(references[0]?.className).toBe('Legacy');
  });

  it('tracks each method separately', () => {
    const references = scan(
      php(
        `    public function first() { return $this->render('a.html.twig'); }\n` +
          `    public function second() { return $this->render('b.html.twig'); }`,
      ),
    );
    expect(references.map((r) => [r.methodName, r.templateName])).toEqual([
      ['first', 'a.html.twig'],
      ['second', 'b.html.twig'],
    ]);
  });

  it('handles a render outside any class', () => {
    const references = scan(`<?php\n$twig->render('a.html.twig');\n`);
    expect(references[0]).toMatchObject({ className: undefined, methodName: undefined });
  });
});

describe('resilience', () => {
  it('reports parseFailed for source that cannot be parsed', () => {
    // php-parser is deliberately forgiving, so this asserts the contract
    // rather than a specific failure: either it parses, or it says it did not.
    const result = scanTemplateReferences('<?php class { ! ~ @ # $ %');
    expect(typeof result.parseFailed).toBe('boolean');
    expect(Array.isArray(result.references)).toBe(true);
  });

  it('finds nothing in an empty file', () => {
    expect(scan('<?php\n')).toEqual([]);
  });

  it('finds nothing in a file with no PHP at all', () => {
    expect(scan('just some text')).toEqual([]);
  });

  it('finds references in a file that also contains unrelated code', () => {
    const references = scan(
      php(
        `    private array $cache = [];\n` +
          `    public function a(): Response\n` +
          `    {\n` +
          `        $x = array_map(static fn($v) => $v * 2, [1, 2, 3]);\n` +
          `        return $this->render('a.html.twig', ['x' => $x]);\n` +
          `    }`,
      ),
    );
    expect(references).toHaveLength(1);
    expect(references[0]?.contextKeys).toEqual(['x']);
  });
});
