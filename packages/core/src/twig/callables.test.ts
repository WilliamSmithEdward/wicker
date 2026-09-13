import { describe, expect, it } from 'vitest';

import { callableGroup, findTwigCallable, scanTwigCallables, twigCallableContextAt, twigCallablesFromDebug } from './callables.js';

function at(marked: string) {
  return twigCallableContextAt(marked.replace('§', ''), marked.indexOf('§'));
}

describe('Twig callable discovery', () => {
  it('reads real Symfony shapes, including null signatures, defaults and empty PHP arrays', () => {
    const catalog = twigCallablesFromDebug({ filters: { upper: ['string'], raw: null, price: ['precision = 2'] }, functions: [] });
    expect(catalog.filters.complete).toBe(true);
    expect(catalog.functions).toEqual({ entries: [], complete: true });
    expect(findTwigCallable(catalog, 'filter', 'raw')?.reportedArguments).toBeUndefined();
    expect(findTwigCallable(catalog, 'filter', 'price')?.reportedArguments).toEqual(['precision = 2']);
  });

  it.each([null, [], {}, { filters: null }, { filters: ['upper'] }, { filters: 'upper' }])('does not treat missing/malformed sections as proof of absence: %j', (payload) => {
    expect(twigCallablesFromDebug(payload).filters.complete).toBe(false);
  });

  it('keeps valid entries but marks a partially malformed group incomplete', () => {
    const catalog = twigCallablesFromDebug({ filters: { upper: [], broken: 3, evil: [{}], 'bad()`': [] }, functions: { path: ['name'] } });
    expect(catalog.filters.complete).toBe(false);
    expect(catalog.filters.entries.map((entry) => entry.name)).toEqual(['upper']);
    expect(catalog.functions.complete).toBe(true);
  });

  it('resolves wildcard registrations without offering their names as literal calls', () => {
    const catalog = twigCallablesFromDebug({ filters: {}, functions: { 'render_*': ['strategy'], render_esi: [], '*_path_*_end': [] } });
    expect(findTwigCallable(catalog, 'function', 'render_hinclude')?.name).toBe('render_*');
    expect(findTwigCallable(catalog, 'function', 'render_esi')?.name).toBe('render_esi');
    expect(findTwigCallable(catalog, 'function', 'my_path_item_end')?.name).toBe('*_path_*_end');
    expect(findTwigCallable(catalog, 'function', 'my_path_item_start')).toBeUndefined();
    expect(findTwigCallable(catalog, 'filter', 'render_esi')).toBeUndefined();
    expect(callableGroup(catalog, 'function').entries).toHaveLength(3);
  });
});

describe('Twig callable positions', () => {
  it.each(['{{ value|§ }}', '{{ value | up§per }}', '{% apply § %}', '{% apply lower|§ %}', '{{ value|date("Y")|§ }}'])('completes filters in %s', (source) => {
    expect(at(source)?.kind).toBe('filter');
  });
  it.each(['{{ § }}', '{{ pa§th() }}', '{{ value|default(pa§th()) }}', '{% set x = ra§nge() %}', '{% for x in ra§nge() %}', '{{ { value: pa§th() } }}', '{{ items|map(x => pa§th()) }}'])('completes functions in %s', (source) => {
    expect(at(source)?.kind).toBe('function');
  });
  it.each([
    'HTML pa§th()', '{# {{ pa§th() }} #}', '{{ "pa§th()" }}', '{{ "#{pa§th()}" }}',
    '{{ app.pa§th() }}', '{{ app?.pa§th() }}', '{{ x is sa§me as(y) }}', '{{ x is not de§fined }}',
    '{% macro pa§th() %}', '{% for pa§th in paths %}', '{% set pa§th = x %}',
    '{{ { pa§th: 3 } }}', '{{ fn(pa§th: 3) }}', '{{ fn(pa§th = 3) }}', '{{ (pa§th) => path }}',
    '{% verbatim %}{{ pa§th() }}{% endverbatim %}', '{{ value + # pa§th()\n 2 }}',
  ])('stays out of non-callable positions in %s', (source) => {
    expect(at(source)).toBeUndefined();
  });
  it('replaces the whole UTF-16 identifier', () => {
    const marked = '😀\r\n{{ value|café§_price }}';
    const source = marked.replace('§', '');
    const context = at(marked)!;
    expect(source.slice(context.range.start, context.range.end)).toBe('café_price');
  });
  it('recognizes nested functions and chained filters in expressions and apply blocks', () => {
    const source = '{{ path("x", {id: random()})|upper|default(cycle([1], 0)) }}{% apply lower|escape("html") %}{% endapply %}';
    expect(scanTwigCallables(source).map((item) => `${item.kind}:${item.name}`)).toEqual([
      'function:path', 'function:random', 'filter:upper', 'filter:default', 'function:cycle', 'filter:lower', 'filter:escape',
    ]);
    for (const item of scanTwigCallables(source)) {
      expect(source.slice(item.range.start, item.range.end)).toBe(item.name);
    }
  });
  it('does not confuse tests, methods, macro declarations/imports or opaque content with functions', () => {
    const source = `{% from 'macros.twig' import link as nav, button %}
      {% macro other(a) %}{% endmacro %}
      {{ nav() }}{{ button() }}{{ _self.other() }}{{ app.method() }}
      {{ x is same as(y) }}{{ x is divisible by(3) }}{{ not(x) }}
      {# {{ fake()|fake }} #}{% verbatim %}{{ fake()|fake }}{% endverbatim %}
      {{ 'fake()|fake' }}{{ value + # fake()|fake
      2 }}{{ real() }}`;
    expect(scanTwigCallables(source).map((item) => item.name)).toEqual(['real']);
    expect(at("{% from 'macros.twig' import link as nav %}{{ na§v() }}")).toBeUndefined();
  });
  it('works in unfinished expressions without diagnosing a bare variable as a function', () => {
    expect(scanTwigCallables('{{ thing|unknown')).toHaveLength(1);
    expect(scanTwigCallables('{{ unknown')).toHaveLength(0);
    expect(at('{{ unknown§')?.kind).toBe('function');
  });
});
