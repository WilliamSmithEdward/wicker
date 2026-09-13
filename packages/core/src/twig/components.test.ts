import { describe, expect, it } from 'vitest';

import { anonymousComponentProps, componentClassSource, componentsFromDebug } from './components.js';
import { componentReferenceAt } from './componentReferences.js';

const table = `+----- Components -----+
| Name | Class | Template | Type |
| Alert | App\\Twig\\Components\\Alert | components/Alert.html.twig | |
| UI:Badge | | @Design/components/Badge.html.twig | Anon |
| Counter | App\\Twig\\Components\\Counter | counter.html.twig | Live |`;

describe('Symfony component discovery', () => {
  it('reads registered names, custom templates, anonymous and live components', () => {
    const items = componentsFromDebug(table)!;
    expect(items.map((item) => item.name)).toEqual(['Alert', 'Counter', 'UI:Badge']);
    expect(items[1]?.live).toBe(true);
    expect(items[2]?.className).toBeUndefined();
    expect(items[2]?.template).toBe('@Design/components/Badge.html.twig');
  });
  it('distinguishes an empty table from an unavailable command', () => {
    expect(componentsFromDebug('Command not found')).toBeUndefined();
    expect(componentsFromDebug('| Name | Class | Template | Type |')).toEqual([]);
  });
  it('ignores banners, malformed rows, arbitrary paths and wrapped output', () => {
    expect(componentsFromDebug(`Warning: deprecation\n${table}
      | Bad | X | ../../secret | |
      | Path | X | /etc/passwd | |
      | ../Unsafe | | components/x.html.twig | Anon |
      | Split | App\\ | |
      | NoType | | components/n.html.twig | Surprise |`)?.length).toBe(3);
  });
});

describe('component source props', () => {
  it('reads own writable properties, mount inputs, setters and promoted properties', () => {
    const source = `<?php namespace App\\Twig\\Components;
      class Alert {
        #[Something(values: ['unused'])] public string $message = 'Hi';
        public string $title, $subtitle;
        public static int $count; private string $secret; protected $internal;
        public readonly string $id;
        public function __construct(public bool $closable, public readonly string $fixed) {}
        public function mount(User $user, string $tone = 'info'): void { $local = 1; }
        public function setColor(string $value): void {}
        private function setSecret(string $value) {}
        public function helper($notAProp): void { $this->notAProp = 1; }
      }`;
    const result = componentClassSource(source, 'App\\Twig\\Components\\Alert')!;
    expect(source.slice(result.range.start, result.range.end)).toBe('Alert');
    expect(result.props.map((prop) => prop.name)).toEqual(['message', 'title', 'subtitle', 'closable', 'user', 'tone', 'color']);
    expect(result.props.filter((prop) => prop.kind !== 'setter').map((prop) => source.slice(prop.range.start, prop.range.end)))
      .toEqual(['message', 'title', 'subtitle', 'closable', 'user', 'tone']);
  });
  it('does not attribute a different class, strings or comments to the registered class', () => {
    expect(componentClassSource('<?php namespace Wrong; class Alert { public $x; }', 'App\\Alert')).toBeUndefined();
    const result = componentClassSource(`<?php namespace App; /* class Alert { public $fake; } */
      class Other { public $other; } class Alert { public $real; }`, 'App\\Alert');
    expect(result?.props.map((p) => p.name)).toEqual(['real']);
  });
  it('does not promise readonly or asymmetric-write properties as input', () => {
    expect(componentClassSource('<?php readonly class Alert { public string $id; public function mount(string $label) {} }', 'Alert')?.props.map((p) => p.name)).toEqual(['label']);
    expect(componentClassSource('<?php class Alert { public private(set) string $id; public string $label; }', 'Alert')?.props.map((p) => p.name)).toEqual(['label']);
  });
  it('reads anonymous props without treating defaults as declarations', () => {
    const source = `{# {% props fake %} #}{% props message, tone = 'info', options = {nested: ['x', 'y']} %}
      {% verbatim %}{% props ignored %}{% endverbatim %}`;
    expect(anonymousComponentProps(source).map((prop) => prop.name)).toEqual(['message', 'tone', 'options']);
  });
});

function at(marked: string) {
  const offset = marked.indexOf('§');
  return componentReferenceAt(marked.replace('§', ''), offset);
}

describe('component reference context', () => {
  it.each(['<twig:Al§ert />', '</twig:Al§ert>', '<twig:§', "{{ component('Al§ert') }}", "{% component 'Al§ert' with {message: x} %}", "{{ component(name: 'Al§ert') }}"])(
    'identifies component names: %s', (source) => { expect(at(source)?.kind).toBe('name'); });
  it('replaces only the name, including namespaces', () => {
    const marked = '<twig:UI:Bu§tton />';
    const context = at(marked)!;
    expect(marked.replace('§', '').slice(context.range.start, context.range.end)).toBe('UI:Button');
  });
  it.each(['<twig:Alert §/>', '<twig:Alert §', '<twig:Alert :me§ssage="value" />', '<twig:Alert me§ssage />', '<twig:Alert\n  §/>'])(
    'suggests props: %s', (source) => { expect(at(source)?.kind).toBe('prop'); });
  it('excludes already supplied props but includes the currently edited name', () => {
    expect(at('<twig:Alert :message="text" to§ne="info" />')).toMatchObject({ prop: 'tone', usedProps: ['message'], hasValue: true });
  });
  it.each([
    '{# <twig:Al§ert /> #}', '{% verbatim %}<twig:Al§ert />{% endverbatim %}',
    '<!-- <twig:Al§ert /> -->', '<div title="<twig:Al§ert />">',
    '<script>const x = "<twig:Al§ert />";</script>', '{{ "<twig:Al§ert />" }}',
    '<twig:Alert message="§" />', '<twig:Alert :message="user.na§me" />',
    '<twig:Alert message="{{ user.na§me }}" />', '<div §>',
    "{{ component('Al§ert' ~ kind) }}", "{{ thing.component('Al§ert') }}",
    "{{ component(variable§) }}", '<twig:component :is="na§me" />', '</twig:Alert §>',
    '<twig:Alert {{ attr§ibutes }} />', '<twig:Alert {# co§mment #} />',
    "{% from 'macros.twig' import link as component %}{{ component('Al§ert') }}",
  ])('declines unrelated or dynamic content: %s', (source) => { expect(at(source)).toBeUndefined(); });
  it('continues across Twig expressions without treating their text as attributes', () => {
    expect(at('<twig:Alert message="{{ text }}" §/>')).toMatchObject({ kind: 'prop', usedProps: ['message'] });
  });
});
