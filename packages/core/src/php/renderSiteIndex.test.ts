import { describe, expect, it } from 'vitest';

import { InMemoryFileSystem } from '../fs/inMemoryFileSystem.js';
import { TwigLoaderPaths } from '../twig/loaderPaths.js';
import { TwigTemplateIndex } from '../twig/templateIndex.js';

import { RenderSiteIndex } from './renderSiteIndex.js';

async function templates(): Promise<TwigTemplateIndex> {
  return TwigTemplateIndex.build(new InMemoryFileSystem({
    '/app/templates/page.twig': '',
    '/app/templates/other.twig': '',
    '/app/vendor/bundle/page.twig': '',
  }), '/app', TwigLoaderPaths.fromDebugTwigJson({
    loader_paths: {
      '(None)': ['templates'],
      '@Theme': ['templates', 'vendor/bundle'],
      '@!Theme': ['vendor/bundle'],
      '@Alias': ['templates'],
    },
  }));
}

describe('RenderSiteIndex', () => {
  it('groups literal controller renders and attributes without including rendering services', () => {
    const index = new RenderSiteIndex();
    index.update('src/Controller/Page.php', `<?php
      namespace App\\Controller;
      class Page {
        public function index() { $this->render('page.twig'); $this->render('missing.twig'); }
        #[Template('other.twig')]
        public function detail() {}
        public function dynamic() { $this->render($name); }
      }
      class Other { public function index() { $this->render('other.twig'); } }
    `);
    index.update('src/Mail/Receipt.php', "<?php namespace App\\Mail; class Receipt { function send() { $twig->render('mail.twig'); } }");
    index.update('src/SpecialController.php', "<?php class SpecialController { function __invoke() { $this->render('page.twig'); } }");
    index.update('src/Controller/Legacy.php', "<?php class Legacy { function index() { $this->render('page.twig'); } }");
    const controllers = index.controllers();
    expect(controllers.map((controller) => controller.className)).toEqual([
      'App\\Controller\\Other', 'App\\Controller\\Page', 'Legacy', 'SpecialController',
    ]);
    expect(controllers[1]?.sites.map((site) => [site.methodName, site.templateName])).toEqual([
      ['index', 'page.twig'], ['index', 'missing.twig'], ['detail', 'other.twig'],
    ]);
    // Edits and deletes replace the groups as well as the reverse index.
    index.update('src/Controller/Page.php', '<?php // removed');
    index.remove('src/SpecialController.php');
    expect(index.controllers().map((controller) => controller.className)).toEqual(['Legacy']);
  });

  it('retains PHP scope, context and exact offsets for calls and attributes', async () => {
    const source = `<?php
namespace App\\Controller;
class PageController {
  public function index() {
    return $this->render('page.twig', ['title' => 'Page', ...$extra]);
  }
  #[Template('page.twig')]
  public function detail() {}
}`;
    const index = new RenderSiteIndex();
    index.update('src/Controller/PageController.php', source);
    const sites = index.forTemplate('templates/page.twig', await templates());
    expect(sites).toHaveLength(2);
    expect(sites[0]).toMatchObject({
      projectPath: 'src/Controller/PageController.php',
      className: 'App\\Controller\\PageController', methodName: 'index',
      kind: 'render', contextKeys: ['title'], contextIsDynamic: true,
    });
    expect(sites[1]).toMatchObject({ kind: 'template-attribute', methodName: 'detail' });
    for (const site of sites) {
      expect(source.slice(site.nameRange.start, site.nameRange.end)).toBe('page.twig');
    }
  });

  it('collects all sources and aliases once, following override and forced-bundle resolution', async () => {
    const index = new RenderSiteIndex();
    index.update('src/B.php', "<?php $twig->render('@Theme/page.twig'); $twig->render('@!Theme/page.twig');");
    index.update('src/A.php', "<?php $twig->render('page.twig'); $twig->render('@Alias/page.twig');");
    const resolved = await templates();
    expect(index.forTemplate('templates/page.twig', resolved).map((site) => site.templateName))
      .toEqual(['page.twig', '@Alias/page.twig', '@Theme/page.twig']);
    expect(index.forTemplate('vendor/bundle/page.twig', resolved).map((site) => site.templateName))
      .toEqual(['@!Theme/page.twig']);
  });

  it('replaces and removes only the changed file, without retaining old references', async () => {
    const index = new RenderSiteIndex();
    const resolved = await templates();
    index.update('src/A.php', "<?php $twig->render('page.twig');");
    index.update('src/B.php', "<?php $twig->render('page.twig');");
    index.update('src/A.php', "<?php $twig->render('other.twig');");
    expect(index.forTemplate('templates/page.twig', resolved).map((site) => site.projectPath))
      .toEqual(['src/B.php']);
    expect(index.forTemplate('templates/other.twig', resolved)).toHaveLength(1);
    index.remove('src/B.php');
    expect(index.forTemplate('templates/page.twig', resolved)).toEqual([]);
    index.update('src/A.php', '<?php // the render was removed');
    expect(index.sourcePaths()).toEqual([]);
    expect(index.forTemplate('templates/other.twig', resolved)).toEqual([]);
  });

  it('does not infer a render from dynamic names, ordinary strings or Twig includes', async () => {
    const index = new RenderSiteIndex();
    index.update('src/A.php', `<?php
      $twig->render('page.' . $suffix);
      $twig->render($name);
      $text = 'page.twig';
      // $twig->render('page.twig');
    ?>{% include 'page.twig' %}`);
    expect(index.forTemplate('templates/page.twig', await templates())).toEqual([]);
  });

  it('uses the current template index when a missing name appears or its winner changes', async () => {
    const index = new RenderSiteIndex();
    index.update('src/A.php', "<?php $twig->render('@Theme/page.twig');");
    expect(index.forTemplate('templates/page.twig', TwigTemplateIndex.fromTemplates([]))).toEqual([]);
    expect(index.forTemplate('templates/page.twig', await templates())).toHaveLength(1);
    const vendorOnly = await TwigTemplateIndex.build(new InMemoryFileSystem({
      '/app/vendor/bundle/page.twig': '',
    }), '/app', TwigLoaderPaths.fromDebugTwigJson({
      loader_paths: { '@Theme': ['templates', 'vendor/bundle'] },
    }));
    expect(index.forTemplate('templates/page.twig', vendorOnly)).toEqual([]);
    expect(index.forTemplate('vendor/bundle/page.twig', vendorOnly)).toHaveLength(1);
  });

  it('normalizes relative paths and rejects roots and paths escaping the project', async () => {
    const index = new RenderSiteIndex();
    const source = "<?php $twig->render('page.twig');";
    for (const path of ['/app/A.php', 'F:\\app\\A.php', '../A.php']) {
      index.update(path, source);
    }
    index.update('src\\Controller\\A.php', source);
    expect(index.sourcePaths()).toEqual(['src/Controller/A.php']);
    expect(index.forTemplate('templates\\page.twig', await templates())).toHaveLength(1);
    index.remove('src\\Controller\\A.php');
    expect(index.sourcePaths()).toEqual([]);
  });
});
