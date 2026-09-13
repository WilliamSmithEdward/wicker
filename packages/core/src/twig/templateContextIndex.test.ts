import { describe, expect, it } from 'vitest';

import { InMemoryFileSystem } from '../fs/inMemoryFileSystem.js';
import { RenderSiteIndex } from '../php/renderSiteIndex.js';

import { twigScopeAt, twigVariableContextAt } from './contextVariables.js';
import { TwigLoaderPaths } from './loaderPaths.js';
import { TemplateContextIndex } from './templateContextIndex.js';
import { TwigTemplateIndex } from './templateIndex.js';

async function fixture(files: Record<string, string>, php = "$this->render('page.twig', ['tasks' => [], 'heading' => 'Tasks']);") {
  const fs = new InMemoryFileSystem(Object.fromEntries(Object.entries(files).map(([name, text]) => [`/app/templates/${name}`, text.replace('§', '')])));
  const templates = await TwigTemplateIndex.build(fs, '/app', TwigLoaderPaths.fromEntries([{ namespace: null, directories: ['templates'], forcesBundleTemplate: false }]));
  const contexts = new TemplateContextIndex();
  for (const [name, text] of Object.entries(files)) { contexts.update(`templates/${name}`, text.replace('§', '')); }
  const renders = new RenderSiteIndex();
  renders.update('src/Controller/PageController.php', `<?php ${php}`);
  const query = (name: string, owns?: (path: string) => boolean) => {
    const text = files[name]!;
    const at = text.includes('§') ? text.indexOf('§') : text.length;
    return contexts.variablesFor(`templates/${name}`, at, templates, renders, owns);
  };
  return { contexts, renders, query, templates, fs };
}

const names = (variables: readonly { name: string }[]) => variables.map((item) => item.name).sort();

describe('Twig local scope evidence', () => {
  it('exposes set, loop and macro bindings at the right positions', () => {
    const source = '{% set title = "hi" %}{% for key, item in items %}{{ § }}{% endfor %}';
    expect(names(twigScopeAt(source, source.indexOf('§')).bindings)).toEqual(['item', 'key', 'loop', 'title']);
    expect(names(twigScopeAt(source, source.length).bindings)).toEqual(['title']);
    const macro = '{% set outside = 1 %}{% macro card(title, options = {}) %}{{ § }}{% endmacro %}';
    const context = twigVariableContextAt(macro.replace('§', ''), macro.indexOf('§'), true);
    expect(context?.isolated).toBe(true);
    expect(names(context!.bindings)).toEqual(['options', 'title', 'varargs']);
  });

  it('reads only outer mapping keys and restores the surrounding scope', () => {
    const source = '{% set outside = 1 %}{% with {title: call(), options: {nested: true}} only %}{{ § }}{% endwith %}';
    expect(names(twigScopeAt(source, source.indexOf('§')).bindings)).toEqual(['options', 'title']);
    expect(names(twigScopeAt(source, source.length).bindings)).toEqual(['outside']);
    expect(twigScopeAt('{% with %}text', 15).isolated).toBe(false);
  });

  it('does not leak loop/conditional branch locals into an else branch', () => {
    const loop = '{% for item in items %}{% else %}{{ § }}{% endfor %}';
    expect(names(twigScopeAt(loop, loop.indexOf('§')).bindings)).toEqual([]);
    const conditional = '{% if ready %}{% set left = 1 %}{% else %}{{ § }}{% endif %}';
    expect(names(twigScopeAt(conditional, conditional.indexOf('§')).bindings)).toEqual([]);
    expect(names(twigScopeAt(conditional, conditional.length).bindings)).toEqual(['left']);
  });

  it('does not confuse an inner if/else with the surrounding loop else', () => {
    const source = '{% for item in items %}{% if item %}a{% else %}{{ § }}{% endif %}{% endfor %}';
    expect(names(twigScopeAt(source, source.indexOf('§')).bindings)).toEqual(['item', 'loop']);
  });

  it('captures the assigned name without treating filters or named call arguments as variables', () => {
    const source = '{% set captured|upper %}text{% endset %}{% do fn(label = 1) %}';
    expect(names(twigScopeAt(source, source.length).bindings)).toEqual(['captured']);
  });
});

describe('Twig rendering context', () => {
  it('propagates controller keys and caller locals through literal includes', async () => {
    const f = await fixture({ 'page.twig': '{% set local = 1 %}{% include "part.twig" %}', 'part.twig': '{{ § }}' });
    expect(names(f.query('part.twig'))).toEqual(['heading', 'local', 'tasks']);
    const heading = f.query('part.twig').find((variable) => variable.name === 'heading')!;
    expect(heading.origins[0]?.projectPath).toBe('src/Controller/PageController.php');
    expect(heading.origins[0]?.via.map((step) => step.kind)).toEqual(['include']);
  });

  it('respects only and explicit overrides without claiming a PHP origin', async () => {
    const f = await fixture({ 'page.twig': '{% include "part.twig" with {title: heading, task: first(tasks)} only %}', 'part.twig': '{{ § }}' });
    expect(names(f.query('part.twig'))).toEqual(['task', 'title']);
    expect(f.query('part.twig').every((item) => item.origins.every((origin) => origin.kind === 'include'))).toBe(true);
    f.contexts.update('templates/page.twig', '{% include "part.twig" with {heading: "override"} %}');
    expect(f.query('part.twig').find((item) => item.name === 'heading')?.origins[0]?.kind).toBe('include');
  });

  it.each([
    '{{ include("part.twig", {title: "x"}, false) }}',
    '{{ include(template: "part.twig", variables: {title: "x"}, with_context: false) }}',
    '{{ include(withContext=false, variables={title: "x"}, template="part.twig") }}',
    '{% set content = include("part.twig", {title: "x"}, with_context: false) %}',
  ])('understands include() arguments in %s', async (source) => {
    const f = await fixture({ 'page.twig': source, 'part.twig': '{{ § }}' });
    expect(names(f.query('part.twig'))).toEqual(['title']);
  });

  it('uses the scope at the call, not assignments after it', async () => {
    const f = await fixture({ 'page.twig': '{% for task in tasks %}{% include "part.twig" %}{% endfor %}{% set later = 1 %}', 'part.twig': '{{ § }}' });
    expect(names(f.query('part.twig'))).toEqual(['heading', 'loop', 'task', 'tasks']);
    expect(f.query('part.twig').find((item) => item.name === 'task')?.origins[0]?.kind).toBe('loop');
  });

  it('unions possible callers and keeps their evidence distinct', async () => {
    const f = await fixture({ 'page.twig': '{% include "part.twig" with {first: 1} only %}{% include "part.twig" with {second: 2} only %}', 'part.twig': '{{ § }}' });
    expect(names(f.query('part.twig'))).toEqual(['first', 'second']);
  });

  it('follows multiple include levels and breaks cycles', async () => {
    const f = await fixture({ 'page.twig': '{% include "middle.twig" %}', 'middle.twig': '{% include "part.twig" %}',
      'part.twig': '{{ § }}{% include "middle.twig" %}' });
    expect(names(f.query('part.twig'))).toEqual(['heading', 'tasks']);
    expect(f.query('part.twig')[0]?.origins[0]?.via).toHaveLength(2);
  });

  it('carries child controller keys and top-level assignments into layouts, not sibling templates', async () => {
    const f = await fixture({ 'page.twig': '{% extends "base.twig" %}{% block body %}{{ § }}{% endblock %}{% set local = 1 %}',
      'sibling.twig': '{% extends "base.twig" %}{{ § }}', 'base.twig': '{{ § }}{% block body %}{% endblock %}' },
    "$this->render('page.twig', ['pageOnly' => true]); $this->render('sibling.twig', ['siblingOnly' => true]);");
    expect(names(f.query('base.twig'))).toEqual(['local', 'pageOnly', 'siblingOnly']);
    expect(names(f.query('page.twig'))).toEqual(['local', 'pageOnly']);
    expect(names(f.query('sibling.twig'))).toEqual(['siblingOnly']);
  });

  it('makes parent assignments before a block available inside the child override', async () => {
    const f = await fixture({ 'page.twig': '{% extends "base.twig" %}{% block body %}{{ § }}{% endblock %}',
      'base.twig': '{% set before = 1 %}{% block body %}{% endblock %}{% set after = 2 %}' });
    expect(names(f.query('page.twig'))).toEqual(['before', 'heading', 'tasks']);
    expect(f.query('page.twig').find((item) => item.name === 'before')?.origins[0]?.projectPath).toBe('templates/base.twig');
  });

  it('parent assignments override child top-level context, while a block-local binding wins inside the block', async () => {
    const f = await fixture({ 'page.twig': '{% extends "base.twig" %}{% set title = "child" %}{% block body %}{{ § }}{% endblock %}',
      'base.twig': '{% set title = "parent" %}{% block body %}{% endblock %}' });
    expect(f.query('page.twig').find((item) => item.name === 'title')?.origins[0]?.projectPath).toBe('templates/base.twig');
    const updated = '{% extends "base.twig" %}{% block body %}{% set title = "local" %}{{ }}{% endblock %}';
    f.contexts.update('templates/page.twig', updated);
    const result = f.contexts.variablesFor('templates/page.twig', updated.indexOf('{{') + 3, f.templates, f.renders);
    expect(result.find((item) => item.name === 'title')?.origins[0]?.projectPath).toBe('templates/page.twig');
  });

  it.each([
    '{% include name ~ "part.twig" %}', '{% include ["part.twig", "other.twig"] %}',
    '{{ include(prefix ~ "part.twig") }}', '{{ object.include("part.twig") }}',
    '{{ "include(\'part.twig\')" }}', '{# {% include "part.twig" %} #}',
    '{% verbatim %}{% include "part.twig" %}{% endverbatim %}',
    '{% import "part.twig" as macros %}', '{% use "part.twig" %}', '{{ source("part.twig") }}',
  ])('does not invent rendering context from %s', async (source) => {
    const f = await fixture({ 'page.twig': source, 'part.twig': '{{ § }}' });
    expect(f.query('part.twig')).toEqual([]);
  });

  it('keeps uncertain maps and macro/with isolation conservative', async () => {
    const f = await fixture({ 'page.twig': '{% macro render(title) %}{% include "part.twig" %}{% endmacro %}', 'part.twig': '{{ § }}' });
    expect(names(f.query('part.twig'))).toEqual(['title', 'varargs']);
    f.contexts.update('templates/page.twig', '{% include "part.twig" with dynamic %}');
    expect(f.query('part.twig')).toEqual([]);
    f.contexts.update('templates/page.twig', '{% with {explicit: 1} only %}{% include "part.twig" %}{% endwith %}');
    expect(names(f.query('part.twig'))).toEqual(['explicit']);
  });

  it('queries current PHP and Twig records, including removed sources', async () => {
    const f = await fixture({ 'page.twig': '{% include "part.twig" %}', 'part.twig': '{{ § }}' });
    f.renders.update('src/Controller/PageController.php', "<?php $this->render('page.twig', ['renamed' => 1]);");
    expect(names(f.query('part.twig'))).toEqual(['renamed']);
    f.contexts.update('templates/page.twig', '{% include "part.twig" only %}');
    expect(f.query('part.twig')).toEqual([]);
    f.contexts.remove('templates/page.twig');
    expect(f.query('part.twig')).toEqual([]);
  });

  it('honors session ownership for both PHP and template sources', async () => {
    const f = await fixture({ 'page.twig': '{% include "part.twig" with {fromTwig: 1} %}', 'part.twig': '{{ § }}' });
    expect(names(f.query('part.twig', (path) => !path.startsWith('src/')))).toEqual(['fromTwig']);
    expect(f.query('part.twig', (path) => path !== 'templates/page.twig')).toEqual([]);
  });

  it('resolves loader overrides when finding callers', async () => {
    const f = await fixture({ 'page.twig': '{% include "part.twig" with {fromTwig: 1} only %}', 'part.twig': '{{ § }}' });
    f.fs.writeFile('/app/override/part.twig', '{{ value }}');
    const overridden = await TwigTemplateIndex.build(f.fs, '/app', TwigLoaderPaths.fromEntries([{ namespace: null, directories: ['override', 'templates'], forcesBundleTemplate: false }]));
    f.contexts.update('override/part.twig', '{{ value }}');
    expect(f.contexts.variablesFor('templates/part.twig', 3, overridden, f.renders)).toEqual([]);
    expect(names(f.contexts.variablesFor('override/part.twig', 3, overridden, f.renders))).toEqual(['fromTwig']);
  });
});
