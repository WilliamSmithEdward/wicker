import { describe, expect, it } from 'vitest';

import { scanTemplateReferences } from '../php/templateReferences.js';

import { templateContextVariables, twigVariableContextAt } from './contextVariables.js';

function at(marked: string) {
  const offset = marked.indexOf('§');
  expect(offset).toBeGreaterThanOrEqual(0);
  return twigVariableContextAt(marked.replace('§', ''), offset);
}

describe('Twig controller-variable positions', () => {
  it.each([
    '{{ ta§sks }}', '{{ § }}', '{{ §', '{{ tasks ?? fa§llback }}',
    '{{ tasks[ke§y] }}', '{{ fn(ta§sks) }}', '{{ tasks|default(fa§llback) }}',
    '{{ { items: ta§sks } }}', '{{ fn(items: ta§sks) }}',
    '{{ ready ? ta§sks : fallback }}', '{{ value + co§unt }}',
    '{% if ta§sks %}', '{% elseif ta§sks %}', '{% for task in ta§sks %}',
    '{% set result = ta§sks %}', '{% include name with { items: ta§sks } %}',
    '{% with { items: ta§sks } %}', '{{- ta§sks -}}', '😀\r\n{{ ta§sks }}',
  ])('accepts an expression root in %s', (source) => {
    expect(at(source)).toBeDefined();
  });

  it.each([
    '<h1>ta§sks</h1>', '{# {{ ta§sks }} #}', '{{ "ta§sks" }}', "{{ 'ta§sks' }}",
    '{{ tasks.ta§sks }}', '{{ tasks?.ta§sks }}', '{{ tasks|ta§sks }}',
    '{{ tasks is de§fined }}', '{{ tasks is not de§fined }}', '{{ ta§sks() }}',
    '{{ { ta§sks: value } }}', '{{ { first: value, ta§sks: value } }}',
    '{{ fn(ta§sks: value) }}', '{{ fn(ta§sks = value) }}', '{{ tr§ue }}',
    '{% fo§r task in tasks %}', '{% for ta§sk in tasks %}', '{% set ta§sks = [] %}',
    '{% block ta§sks %}', '{% import "macros.twig" as ta§sks %}',
    '{{ tasks § }}', '{{ tasks. § }}', '{{ tasks| § }}', '{{ tasks is § }}',
    '{% verbatim %}{{ ta§sks }}{% endverbatim %}',
    '{{ tasks|map(tasks => ta§sks) }}', '{% do ta§sks = [] %}',
  ])('does not mistake a label or non-expression for a variable in %s', (source) => {
    expect(at(source)).toBeUndefined();
  });

  it('returns the entire replacement range, measured in UTF-16 offsets', () => {
    const source = '😀\r\n{{ tasks }}';
    const context = twigVariableContextAt(source, source.indexOf('tasks') + 2);
    expect(context?.range).toEqual({ start: 7, end: 12 });
    expect(context?.name).toBe('tasks');
  });

  it('allows expressions following a verbatim block', () => {
    expect(at('{% verbatim %}{{ tasks }}{% endverbatim %}{{ ta§sks }}')).toBeDefined();
  });

  it('tracks loop bindings without hiding the iterable or leaking the binding', () => {
    expect(at('{% for tasks in ta§sks %}')?.localNames.has('tasks')).toBe(false);
    expect(at('{% for tasks in items %}{{ ta§sks }}')?.localNames.has('tasks')).toBe(true);
    expect(at('{% for tasks in items %}{% endfor %}{{ ta§sks }}')?.localNames.has('tasks')).toBe(false);
  });

  it('keeps outer loop bindings when leaving an inner loop', () => {
    expect(at('{% for tasks in items %}{% for item in tasks %}{% endfor %}{{ ta§sks }}')
      ?.localNames.has('tasks')).toBe(true);
  });

  it('hides assigned names only after their value expression', () => {
    expect(at('{% set tasks = ta§sks %}')?.localNames.has('tasks')).toBe(false);
    expect(at('{% set tasks = [] %}{{ ta§sks }}')?.localNames.has('tasks')).toBe(true);
    expect(at('{% set tasks %}{{ ta§sks }}{% endset %}')?.localNames.has('tasks')).toBe(false);
    expect(at('{% set tasks %}text{% endset %}{{ ta§sks }}')?.localNames.has('tasks')).toBe(true);
  });

  it('conservatively hides names assigned conditionally or by a loop', () => {
    expect(at('{% if ready %}{% set tasks = [] %}{% endif %}{{ ta§sks }}')?.localNames.has('tasks')).toBe(true);
    expect(at('{% for item in items %}{% set tasks = [] %}{% endfor %}{{ ta§sks }}')?.localNames.has('tasks')).toBe(true);
    expect(at('{% do tasks = [] %}{{ ta§sks }}')?.localNames.has('tasks')).toBe(true);
  });

  it('hides imported macros and aliases', () => {
    expect(at('{% import "macros.twig" as tasks %}{{ ta§sks }}')?.localNames.has('tasks')).toBe(true);
    expect(at('{% from "macros.twig" import original as tasks, heading %}{{ ta§sks }}')?.localNames)
      .toEqual(new Set(['tasks', 'heading']));
  });

  it('respects with-map overrides and restores the enclosing context', () => {
    expect(at('{% with { tasks: [] } %}{{ ta§sks }}')?.localNames.has('tasks')).toBe(true);
    expect(at('{% with { tasks: [] } %}{% endwith %}{{ ta§sks }}')?.localNames.has('tasks')).toBe(false);
  });

  it.each([
    '{% macro list() %}{{ ta§sks }}{% endmacro %}',
    '{% with {} only %}{{ ta§sks }}{% endwith %}',
    '{% with dynamicContext %}{{ ta§sks }}{% endwith %}',
    '{% embed "base.twig" only %}{{ ta§sks }}{% endembed %}',
    '{% with { ...context } %}{{ ta§sks }}{% endwith %}',
  ])('does not attribute an isolated or uncertain scope to a controller: %s', (source) => {
    expect(at(source)).toBeUndefined();
  });
});

describe('controller context evidence', () => {
  it('unions literal keys and retains their source sites, including partial dynamic maps', () => {
    const scan = scanTemplateReferences(`<?php
      $this->render('index.twig', ['tasks' => [], 'heading' => 'Tasks', ...$extra]);
      $this->render('index.twig', ['tasks' => []]);
      $this->render('index.twig', $unknown);
    `);
    const sites = scan.references.map((reference) => ({ ...reference, projectPath: 'src/Controller.php' }));
    const variables = templateContextVariables(sites);
    expect(variables.map((variable) => [variable.name, variable.sources.length, variable.renderSiteCount]))
      .toEqual([['heading', 1, 3], ['tasks', 2, 3]]);
    expect(variables[1]?.sources).toEqual(sites.slice(0, 2));
  });

  it('omits keys that cannot be read as bare Twig identifiers', () => {
    const scan = scanTemplateReferences(`<?php $this->render('index.twig', [
      '1' => 1, 'foo-bar' => 2, 'true' => 3, '_context' => 4, 'café' => 5,
    ]);`);
    expect(templateContextVariables(scan.references.map((reference) => ({ ...reference, projectPath: 'src/Test.php' })))
      .map((variable) => variable.name)).toEqual(['café']);
  });
});
