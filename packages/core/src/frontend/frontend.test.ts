import { describe, expect, it } from 'vitest';
import { FrontendIndex } from './index.js';
import { scanFrontend } from './references.js';
import { responseAccessAt } from './responseAccess.js';
import { endpointActions, routeForUrl, routesFromDebug, type SymfonyRoute } from './routes.js';
import { stimulusClassProperties, stimulusDeclarationRanges, stimulusGeneratedMembers, stimulusIdentifier, stimulusSource } from './stimulus.js';

const route: SymfonyRoute = { name: 'api_status', path: '/api/status', methods: 'GET', controller: 'App\\Controller\\StatusController::status', format: '' };
describe('Stimulus declarations', () => {
  it('maps nested JS/TS names using StimulusBundle conventions', () => {
    expect(stimulusIdentifier('admin/user_card_controller.ts')).toBe('admin--user-card');
    expect(stimulusIdentifier('hello-controller.js')).toBe('hello');
    expect(stimulusIdentifier('helper.js')).toBeUndefined();
  });
  it('reads direct actions, target strings and top-level value keys with exact ranges', () => {
    const source = `import { Controller } from '@hotwired/stimulus';
      export default class extends Controller {
        static targets = ['output', 'status'];
        static values = { url: String, itemCount: { type: Number, default: 1 } };
        connect() { this.start(); }
        async refresh(event) { const text = 'fake() {}'; }
        #secret() {}
        static utility() {}
        get result() { return 1; }
        urlValueChanged() {}
        outputTargetConnected() {}
        reset() {}
      }`;
    const parsed = stimulusSource(source);
    expect(parsed.actions.map((entry) => entry.name)).toEqual(['refresh', 'reset']);
    expect(parsed.targets.map((entry) => entry.name)).toEqual(['output', 'status']);
    expect(parsed.values.map((entry) => entry.name)).toEqual(['url', 'itemCount']);
    for (const entry of [...parsed.actions, ...parsed.targets, ...parsed.values]) {
      expect(source.slice(entry.range.start, entry.range.end)).toBe(entry.name);
    }
  });
  it('ignores comments, computed members and side-effect modules', () => {
    expect(stimulusSource('// export default class { fake() {} }').actions).toEqual([]);
    expect(stimulusSource('export default class { [method]() {} }').actions).toEqual([]);
    expect(stimulusSource('export function connect() {}').actions).toEqual([]);
  });

  /*
   * Names that also exist on Object.prototype. Bracket matching looked its
   * table up as a plain object, so `constructor` answered with the Object
   * constructor, counted as an opening bracket, and left the stack unbalanced
   * for the rest of the class: a controller with a constructor reported no
   * members whatsoever.
   */
  const prototypeNames = [
    'constructor(...args) { super(...args); }',
    'toString() { return \'\'; }',
    'valueOf() { return 0; }',
    'hasOwnProperty(name) { return false; }',
  ];
  it.each(prototypeNames)('reads members past a method named %s', (method) => {
    const parsed = stimulusSource(`export default class extends Controller {
        static targets = ['output'];
        static values = { url: String };
        ${method}
        refresh() {}
      }`);
    expect(parsed.targets.map((entry) => entry.name)).toEqual(['output']);
    expect(parsed.values.map((entry) => entry.name)).toEqual(['url']);
    expect(parsed.actions.map((entry) => entry.name)).toContain('refresh');
  });
});

describe('value types and defaults', () => {
  const values = stimulusSource(`export default class extends Controller {
    static values = {
      url: String,
      itemCount: { type: Number, default: 1 },
      tags: { type: Array, default: ['a', 'b'] },
      options: { type: Object, default: { deep: true } },
      ready: { type: Boolean },
      computed: someType,
    };
  }`).values;
  const byName = (name: string): typeof values[number] | undefined => values.find((value) => value.name === name);

  it('reads the short form, where the type is named directly', () => {
    expect(byName('url')).toMatchObject({ type: 'String' });
    expect(byName('url')?.defaultText).toBeUndefined();
  });

  it('reads the object form, with both type and default', () => {
    expect(byName('itemCount')).toMatchObject({ type: 'Number', defaultText: '1' });
    expect(byName('ready')).toMatchObject({ type: 'Boolean' });
  });

  it('keeps a structured default whole rather than its first token', () => {
    expect(byName('tags')).toMatchObject({ type: 'Array', defaultText: "['a', 'b']" });
    expect(byName('options')).toMatchObject({ type: 'Object', defaultText: '{ deep: true }' });
  });

  it('claims no type it cannot read literally', () => {
    expect(byName('computed')?.type).toBeUndefined();
  });

  it('still finds every declared name', () => {
    expect(values.map((value) => value.name))
      .toEqual(['url', 'itemCount', 'tags', 'options', 'ready', 'computed']);
  });
});

describe('stimulusGeneratedMembers', () => {
  const source = `export default class extends Controller {
    static targets = ['output'];
    static values = { statusUrl: String };
    static classes = ['error-state'];
    static outlets = ['wicker-counter'];
  }`;
  const members = stimulusGeneratedMembers(stimulusSource(source));
  const named = (kind: string): string[] => members.filter((m) => m.kind === kind).map((m) => m.name);

  it('names the properties a target generates', () => {
    expect(named('target')).toEqual(['outputTarget', 'outputTargets', 'hasOutputTarget']);
  });

  it('names the properties a value generates', () => {
    expect(named('value')).toEqual(['statusUrlValue', 'hasStatusUrlValue']);
  });

  it('camel-cases class and outlet names, which may contain dashes', () => {
    expect(named('class')).toEqual(['errorStateClass', 'errorStateClasses', 'hasErrorStateClass']);
    expect(named('outlet')).toContain('wickerCounterOutlet');
  });

  it('carries each property back to the declaration it came from', () => {
    const busy = members.find((member) => member.name === 'errorStateClass');
    expect(busy?.declaration.name).toBe('error-state');
    expect(source.slice(busy!.declaration.range.start, busy!.declaration.range.end)).toBe('error-state');
  });

  it('generates nothing for a controller that declares nothing', () => {
    expect(stimulusGeneratedMembers(stimulusSource('export default class {}'))).toEqual([]);
  });
});

describe('dispatched events', () => {
  const source = `export default class extends Controller {
    add() {
      this.dispatch('added', { detail: { id: 1 } });
      this.dispatch('changed');
    }
    quiet() {
      this.dispatch('raw', { prefix: false });
      this.dispatch(computedName);
    }
  }`;
  const found = stimulusSource(source).dispatches;

  it('reads every literal dispatched name', () => {
    expect(found.map((entry) => entry.name)).toEqual(['added', 'changed', 'raw']);
    for (const entry of found) {
      expect(source.slice(entry.range.start, entry.range.end)).toBe(entry.name);
    }
  });

  it('marks a call that overrides the prefix, whose event name it cannot compose', () => {
    // Stimulus emits "<identifier>:added" by default. A prefix option changes
    // that, and the option's value is not read, so no claim is made.
    expect(found.filter((entry) => entry.defaultPrefix).map((entry) => entry.name)).toEqual(['added', 'changed']);
  });

  it('reads nothing from a computed name', () => {
    expect(found.some((entry) => entry.name.includes('computed'))).toBe(false);
  });
});

describe('stimulusDeclarationRanges', () => {
  const source = `import { Controller } from '@hotwired/stimulus';
export default class extends Controller {
  static values = { statusUrl: String, fragmentUrl: String };
  static targets = ['output'];
  static outlets = ['wicker-counter'];
  static classes = ['loading', 'error-state'];
  async refresh() { const response = await fetch(this.statusUrlValue); this.outputTarget.textContent = 'x'; }
}`;

  function marked(ranges: readonly { start: number; end: number }[]): string[] {
    return ranges.map((range) => source.slice(range.start, range.end));
  }

  it('marks every declared value, target, outlet and class', () => {
    expect(marked(stimulusDeclarationRanges(stimulusSource(source))))
      .toEqual(['statusUrl', 'fragmentUrl', 'output', 'wicker-counter', 'loading', 'error-state']);
  });

  it('marks neither the types beside a value nor the accessors generated from it', () => {
    // The colour says "this name is declared here". String is a type, and
    // statusUrlValue is a use of the declaration rather than another one.
    const text = marked(stimulusDeclarationRanges(stimulusSource(source)));
    expect(text).not.toContain('String');
    expect(text).not.toContain('statusUrlValue');
    expect(text).not.toContain('outputTarget');
  });

  it('returns nothing for a file that declares no members', () => {
    expect(stimulusDeclarationRanges(stimulusSource('export default class {}'))).toEqual([]);
  });

  it('keeps each kind of member apart', () => {
    const info = stimulusSource(source);
    expect(info.classes.map((member) => member.name)).toEqual(['loading', 'error-state']);
    expect(info.targets.map((member) => member.name)).toEqual(['output']);
    expect(info.outlets.map((member) => member.name)).toEqual(['wicker-counter']);
  });
});

describe('stimulusClassProperties', () => {
  it('names the properties a logical class generates', () => {
    expect(stimulusClassProperties('loading'))
      .toEqual(['loadingClass', 'loadingClasses', 'hasLoadingClass']);
  });

  it('camel-cases a hyphenated name the way Stimulus does', () => {
    expect(stimulusClassProperties('error-state'))
      .toEqual(['errorStateClass', 'errorStateClasses', 'hasErrorStateClass']);
  });
});

describe('Twig/JavaScript frontend references', () => {
  it('connects helper controllers, actions, targets, values and route bindings', () => {
    const source = `{{ stimulus_controller('status', {url: path('api_status')}) }}
      {{ stimulus_action('status', 'refresh', 'click')|stimulus_target('status', 'output') }}`;
    const parsed = scanFrontend(source, true);
    expect(parsed.references.map((entry) => [entry.kind, entry.name])).toEqual([
      ['controller', 'status'], ['value', 'url'], ['route', 'api_status'], ['controller', 'status'], ['action', 'refresh'], ['controller', 'status'], ['target', 'output'],
    ]);
    expect(parsed.bindings[0]).toMatchObject({ controller: 'status', value: 'url', endpoint: { kind: 'route', name: 'api_status' } });
    for (const entry of parsed.references) { expect(source.slice(entry.range.start, entry.range.end)).toBe(entry.name); }
  });
  it('reads logical CSS class names from the helper and the HTML attribute', () => {
    const source = `{{ stimulus_controller('slideshow', {}, {loading: 'spinner border', 'error-state': 'red'}) }}
      <div data-slideshow-loading-class="spinner border"></div>`;
    const parsed = scanFrontend(source, true);
    const classes = parsed.references.filter((ref) => ref.kind === 'class');
    expect(classes.map((ref) => [ref.controller, ref.name]))
      .toEqual([['slideshow', 'loading'], ['slideshow', 'error-state'], [undefined, 'slideshow-loading']]);
    for (const entry of classes) { expect(source.slice(entry.range.start, entry.range.end)).toBe(entry.name); }
  });

  it('treats the mapped CSS as stylesheet content rather than a declaration', () => {
    // Only the key is a Stimulus name. "spinner border" is ordinary CSS and
    // claiming it would put the extension's colour on someone else's classes.
    const parsed = scanFrontend(`{{ stimulus_controller('slideshow', {}, {loading: 'spinner border'}) }}`, true);
    expect(parsed.references.filter((ref) => ref.name.includes('spinner'))).toEqual([]);
  });

  it('accepts the class map as a named argument', () => {
    const parsed = scanFrontend(`{{ stimulus_controller('slideshow', controllerClasses: {loading: 'spinner'}) }}`, true);
    expect(parsed.references.filter((ref) => ref.kind === 'class').map((ref) => ref.name)).toEqual(['loading']);
  });

  it('reads the event half of an action descriptor, which nothing else checks', () => {
    const source = `<div data-action="keydown.enter@window->search#submit:prevent click->cart#add"></div>`;
    const parsed = scanFrontend(source, true);
    expect(parsed.references.map((ref) => [ref.kind, ref.name])).toEqual([
      ['event', 'keydown'], ['keyFilter', 'enter'], ['eventTarget', 'window'],
      ['actionOption', 'prevent'], ['controller', 'search'], ['action', 'submit'],
      ['event', 'click'], ['controller', 'cart'], ['action', 'add'],
    ]);
    for (const entry of parsed.references) { expect(source.slice(entry.range.start, entry.range.end)).toBe(entry.name); }
  });

  it('reports no event for a descriptor relying on the element default', () => {
    // `<button data-action="cart#add">` binds click without naming it, so
    // there is no event text to point at.
    const parsed = scanFrontend('<button data-action="cart#add"></button>', true);
    expect(parsed.references.map((ref) => ref.kind)).toEqual(['controller', 'action']);
  });

  it('reads logical asset paths and importmap entrypoints', () => {
    const source = `<link rel="stylesheet" href="{{ asset('styles/app.css') }}">
      {{ importmap('app') }}`;
    const parsed = scanFrontend(source, true);
    expect(parsed.references.map((ref) => [ref.kind, ref.name]))
      .toEqual([['asset', 'styles/app.css'], ['entrypoint', 'app']]);
    for (const entry of parsed.references) { expect(source.slice(entry.range.start, entry.range.end)).toBe(entry.name); }
  });

  it('leaves a computed asset path alone rather than guessing at it', () => {
    expect(scanFrontend(`{{ asset('images/' ~ name ~ '.png') }}`, true).references).toEqual([]);
    expect(scanFrontend(`{{ importmap(['app', 'admin']) }}`, true).references).toEqual([]);
  });

  it('handles multiple controllers, action options and target lists', () => {
    const source = `<div data-controller="status other" data-action="click->status#refresh:prevent keydown.enter@window->other#run"
      data-status-target="output status" data-status-url-value="{{ path('api_status') }}"></div>`;
    const parsed = scanFrontend(source, true);
    expect(parsed.references.filter((ref) => ref.kind === 'action').map((ref) => [ref.controller, ref.name])).toEqual([['status', 'refresh'], ['other', 'run']]);
    expect(parsed.references.filter((ref) => ref.kind === 'target').map((ref) => ref.name)).toEqual(['output', 'status']);
    expect(parsed.bindings).toHaveLength(1);
  });
  it('offers empty names at helper and HTML editing positions', () => {
    expect(scanFrontend(`{{ stimulus_action('status', '') }}`, true).references.at(-1)).toMatchObject({ kind: 'action', name: '' });
    expect(scanFrontend('<div data-controller="status ">', true).references.at(-1)).toMatchObject({ kind: 'controller', name: '' });
    expect(scanFrontend('<button data-action="click->status#">', true).references.at(-1)).toMatchObject({ kind: 'action', name: '' });
  });
  it('ignores Twig comments/verbatim, HTML comments and JS markup strings', () => {
    const source = `{# {{ stimulus_controller('fake') }} #}
      {% verbatim %}{{ stimulus_controller('fake') }}<div data-controller="fake">{% endverbatim %}
      <!-- <div data-controller="fake"> -->
      <!-- {{ stimulus_controller('fake') }} {{ path('fake') }} -->
      <script>const example = '<div data-controller="fake">'; // fetch('/api/status')
      fetch('/api/status');</script>`;
    expect(scanFrontend(source, true).references.map((ref) => ref.kind)).toEqual(['url']);
  });
  it('does not treat arbitrary URL strings or concatenated fetch arguments as requests', () => {
    expect(scanFrontend(`const url = '/api/status'; /* fetch('/api/status') */ fetch('/api/' + id);`, false).references).toEqual([]);
    expect(scanFrontend(`fetch('//external.test/api/status')`, false).references).toEqual([]);
    expect(scanFrontend(`client.fetch('/api/status')`, false).requests).toEqual([]);
    expect(scanFrontend(`<script>const url = "{{ path('api_status') }}";</script>`, true).requests).toEqual([]);
    expect(scanFrontend(`<script>fetch("{{ path('api_status') }}")</script>`, true).requests[0]).toMatchObject({ kind: 'route', name: 'api_status' });
  });

  /*
   * Each block is lexed as its own span of the one template, so a reader that
   * confuses two spans reports the first block's code as the second's. The
   * offsets are checked as well as the names, because a wrong span still
   * yields plausible-looking names while pointing at the wrong text.
   */
  it('keeps two script blocks in one template apart', () => {
    const source = [
      `<script>fetch('/api/first');</script>`,
      `<p>between</p>`,
      `<script>fetch('/api/second');</script>`,
    ].join('\n');
    const scan = scanFrontend(source, true);

    expect(scan.requests.map((request) => request.name)).toEqual(['/api/first', '/api/second']);
    for (const request of scan.requests) {
      expect(source.slice(request.range.start, request.range.end)).toBe(request.name);
    }
    expect(scan.scripts.length).toBe(2);
  });
});

describe('endpoint declarations', () => {
  it('reads actual debug:router JSON and rejects malformed data', () => {
    expect(routesFromDebug(JSON.stringify({ api_status: { path: '/api/status', method: 'GET', defaults: { _controller: route.controller } } }))).toEqual([route]);
    expect(routesFromDebug('invalid')).toBeUndefined();
    expect(routesFromDebug('{"routes":[]}')).toBeUndefined();
    expect(routesFromDebug('[]')).toBeUndefined();
  });
  it('resolves only unambiguous literal URLs', () => {
    expect(routeForUrl([route], '/api/status?verbose=1')).toEqual(route);
    expect(routeForUrl([route, { ...route, name: 'other' }], '/api/status')).toBeUndefined();
    expect(routeForUrl([{ ...route, path: '/api/{id}' }], '/api/12')).toBeUndefined();
  });
  it('reads JSON keys, nested shapes and rendered templates in their own actions', () => {
    const source = `<?php namespace App\\Controller;
      use Symfony\\Component\\HttpFoundation\\JsonResponse as Json;
      #[Route('/api')]
      class StatusController {
        #[Route('/status', name: 'api_status', methods: ['GET'])]
        public function status(): Json { return new Json(['message' => 'Ready', 'meta' => ['total' => 2]]); }
        public function fragment() { return $this->render('status/fragment.html.twig'); }
      }`;
    const actions = endpointActions(source);
    expect(actions[0]).toMatchObject({ className: 'App\\Controller\\StatusController', methodName: 'status', json: true });
    expect(actions[0]?.fields.map((field) => field.name)).toEqual(['message', 'meta']);
    expect(actions[0]?.fields[1]?.fields[0]?.name).toBe('total');
    expect(actions[1]?.templates).toEqual(['status/fragment.html.twig']);
    for (const field of actions[0]!.fields) { expect(source.slice(field.range.start, field.range.end)).toBe(field.name); }
  });
  it('only suggests fields shared by all return branches', () => {
    const source = `<?php class C { function status() { if ($error) { return $this->json(['message' => 'Error']); } return $this->json(['message' => 'OK', 'count' => 2]); } }`;
    expect(endpointActions(source)[0]?.fields.map((field) => field.name)).toEqual(['message']);
    expect(endpointActions(source.replace("['message' => 'Error']", '$dynamic'))[0]?.fields).toEqual([]);
  });
  it('ignores fake declarations in PHP strings and nested function returns', () => {
    const source = `<?php class C { function status() { $f = function () { return $this->json(['fake' => 1]); }; return $this->json(['real' => 1]); } }`;
    expect(endpointActions(source)[0]?.fields.map((field) => field.name)).toEqual(['real']);
  });
});

describe('response field access', () => {
  const prefix = `async function show() { const response = await fetch('/api/status'); const data = await response.json(); `;
  it('follows local await fetch/json assignments through nested property access', () => {
    const source = `${prefix}data.meta.to }`;
    expect(responseAccessAt(source, source.indexOf('to }') + 2, false)).toMatchObject({ name: 'to', path: ['meta'], endpoint: { kind: 'url', name: '/api/status' } });
    const empty = `${prefix}data. }`;
    expect(responseAccessAt(empty, empty.indexOf('data. }') + 5, false)?.name).toBe('');
  });
  it('connects a Stimulus URL value and inline Twig route generation', () => {
    const value = `${prefix.replace("'/api/status'", 'this.urlValue')}data.message }`;
    expect(responseAccessAt(value, value.indexOf('message') + 3, false)?.endpoint).toMatchObject({ kind: 'stimulus-value', name: 'url' });
    const inline = `<script>${prefix.replace("'/api/status'", `"{{ path('api_status') }}"`)}data.message }</script>`;
    expect(responseAccessAt(inline, inline.indexOf('message') + 3, true)?.endpoint).toMatchObject({ kind: 'route', name: 'api_status' });
  });
  it('does not leak across functions or through reassignment, comments and unrelated objects', () => {
    const other = `${prefix}} function other() { data.message }`;
    expect(responseAccessAt(other, other.lastIndexOf('message') + 3, false)).toBeUndefined();
    const overwritten = `${prefix}data = other; data.message }`;
    expect(responseAccessAt(overwritten, overwritten.lastIndexOf('message') + 3, false)).toBeUndefined();
    const comment = `${prefix}// data.message\n }`;
    expect(responseAccessAt(comment, comment.indexOf('message') + 3, false)).toBeUndefined();
  });
});

describe('consumer index', () => {
  it('connects Twig bindings and actual JS requests, and updates on removal', () => {
    const index = new FrontendIndex();
    index.update('templates/status.html.twig', `{{ stimulus_controller('status', {url: path('api_status')}) }}`);
    index.update('assets/controllers/status_controller.js', 'export default class { async load() { const response = await fetch(this.urlValue); } }');
    const controllers = [{ name: 'status', projectPath: 'assets/controllers/status_controller.js' }];
    expect(index.consumers(route, [route], controllers).map((use) => use.projectPath)).toEqual(['templates/status.html.twig', 'assets/controllers/status_controller.js']);
    index.remove('templates/status.html.twig');
    expect(index.consumers(route, [route], controllers)).toEqual([]);
  });

  // The answers are derived once for every route and reused. An edit has to
  // discard that, or the index keeps reporting what the file used to say.
  it('reflects an edited file rather than the answer derived before it', () => {
    const index = new FrontendIndex();
    index.update('templates/status.html.twig', `{{ stimulus_controller('status', {url: path('api_status')}) }}`);
    const controllers = [{ name: 'status', projectPath: 'assets/controllers/status_controller.js' }];
    expect(index.consumers(route, [route], controllers).map((use) => use.projectPath))
      .toEqual(['templates/status.html.twig']);

    index.update('templates/status.html.twig', '<p>nothing binds a route now</p>');
    expect(index.consumers(route, [route], controllers)).toEqual([]);

    index.update('templates/status.html.twig', `{{ stimulus_controller('status', {url: path('api_status')}) }}`);
    expect(index.consumers(route, [route], controllers).map((use) => use.projectPath))
      .toEqual(['templates/status.html.twig']);
  });

  // The parsed structures come to several times the text, so an index with no
  // ceiling is a way for one enormous project to take the editor down with it.
  it('stops retaining once it is holding too much', () => {
    const index = new FrontendIndex();
    const chunk = 'x'.repeat(4 * 1024 * 1024);
    for (let i = 0; i < 9; i += 1) { index.update(`assets/big_${i}.css`, chunk); }
    expect(index.all().length).toBeLessThan(9);
  });

  it('counts a replaced file once rather than every time it is written', () => {
    const index = new FrontendIndex();
    const chunk = 'x'.repeat(8 * 1024 * 1024);
    for (let i = 0; i < 10; i += 1) { index.update('assets/one.css', chunk); }
    expect(index.all().length).toBe(1);
  });

  it('answers the same for a route list rebuilt with equal contents', () => {
    const index = new FrontendIndex();
    index.update('templates/status.html.twig', `{{ stimulus_controller('status', {url: path('api_status')}) }}`);
    const controllers = [{ name: 'status', projectPath: 'assets/controllers/status_controller.js' }];
    expect(index.consumers(route, [route], controllers).length).toBe(1);
    // A rebuild hands over fresh arrays holding the same routes.
    expect(index.consumers({ ...route }, [{ ...route }], [...controllers]).length).toBe(1);
  });
});
