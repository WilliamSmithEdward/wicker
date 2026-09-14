import { describe, expect, it } from 'vitest';
import { FrontendIndex } from './index.js';
import { outletAccessAt, outletUseRanges, resolveOutletReference } from './outlets.js';
import { scanFrontend } from './references.js';
import { stimulusOutletProperties, stimulusSource } from './stimulus.js';

describe('Stimulus outlets', () => {
  const source = `export default class extends Controller {
    static outlets = ['admin--user-status'];
    connect() { this.adminUserStatusOutlet.refresh(); this.hasAdminUserStatusOutlet; }
    adminUserStatusOutletConnected(outlet, element) {}
    adminUserStatusOutletDisconnected(outlet, element) {}
    refresh() {}
  }`;
  it('reads declarations and callbacks without offering callbacks as actions', () => {
    const info = stimulusSource(source);
    expect(info.outlets.map((member) => member.name)).toEqual(['admin--user-status']);
    expect(info.outletCallbacks.map((member) => member.name)).toEqual(['adminUserStatusOutletConnected', 'adminUserStatusOutletDisconnected']);
    expect(info.actions.map((member) => member.name)).toEqual(['refresh']);
    expect(outletUseRanges(info, 'admin--user-status').map((range) => source.slice(range.start, range.end))).toEqual([
      'adminUserStatusOutlet', 'hasAdminUserStatusOutlet', 'adminUserStatusOutletConnected', 'adminUserStatusOutletDisconnected',
    ]);
  });
  it('generates the documented namespaced properties', () => {
    expect(stimulusOutletProperties('admin--user-status')).toEqual([
      'adminUserStatusOutlet', 'adminUserStatusOutlets', 'adminUserStatusOutletElement', 'adminUserStatusOutletElements', 'hasAdminUserStatusOutlet',
    ]);
  });
  it('resolves declaration strings, properties, callback names and direct outlet methods', () => {
    for (const [text, expected] of [
      ['admin--user-status', { kind: 'declaration', name: 'admin--user-status' }],
      ['adminUserStatusOutlet.refresh', { kind: 'property', name: 'adminUserStatusOutlet' }],
      ['refresh();', { kind: 'method', name: 'refresh', outlet: 'admin--user-status' }],
      ['adminUserStatusOutletConnected', { kind: 'callback', outlet: 'admin--user-status' }],
    ] as const) {
      expect(outletAccessAt(source, stimulusSource(source), source.indexOf(text) + 2)).toMatchObject(expected);
    }
  });
  it('supports empty strings and member positions during editing', () => {
    for (const marked of [`export default class { static outlets = ['§']; }`,
      `export default class { static outlets = ['peer']; run() { this.§ } }`,
      `export default class { static outlets = ['peer']; run() { this.peerOutlet.§ } }`]) {
      const input = marked.replace('§', '');
      expect(outletAccessAt(input, stimulusSource(input), marked.indexOf('§'))?.name).toBe('');
    }
  });
  it('ignores comments, strings, computed declarations and nested ordinary functions', () => {
    const input = `export default class {
      static outlets = [computed, 'peer' + suffix, ...other];
      run() { /* this.peerOutlet */ const text = 'this.peerOutlet'; function nested() { this.peerOutlet; } }
    }`;
    const info = stimulusSource(input);
    expect(info.outlets).toEqual([]);
    expect(info.accesses).toEqual([]);
  });
  it('keeps arrow-function connections to the controller', () => {
    const input = `export default class { static outlets = ['peer']; connect() { queueMicrotask(() => this.peerOutlet.run()); } }`;
    expect(outletUseRanges(stimulusSource(input), 'peer')).toHaveLength(1);
  });
  it('does not treat static methods as controller instances or outlet callbacks', () => {
    const input = `export default class { static outlets = ['peer'];
      static utility() { this.peerOutlet.run(); }
      static peerOutletConnected() {}
    }`;
    const info = stimulusSource(input);
    expect(outletUseRanges(info, 'peer')).toEqual([]);
    expect(info.outletCallbacks).toEqual([]);
  });
  it('parses positional, named and filtered Twig outlet maps with exact ranges', () => {
    for (const input of [
      `{{ stimulus_controller('host', {}, {}, {'admin--user-status': '.online'}) }}`,
      `{{ stimulus_controller(controllerOutlets: {'admin--user-status': '.online'}, controllerName: 'host') }}`,
      `{{ stimulus_controller('other')|stimulus_controller('host', controllerOutlets: {'admin--user-status': '.online'}) }}`,
    ]) {
      const ref = scanFrontend(input, true).references.find((ref) => ref.kind === 'outlet')!;
      expect(ref).toMatchObject({ name: 'admin--user-status', controller: 'host', selector: { name: '.online' } });
      expect(input.slice(ref.range.start, ref.range.end)).toBe(ref.name);
      expect(input.slice(ref.selector!.range.start, ref.selector!.range.end)).toBe('.online');
    }
  });
  it('handles named action, target and value arguments alongside outlets', () => {
    const refs = scanFrontend(`{{ stimulus_action(actionName: 'go', controllerName: 'host') }}
      {{ stimulus_target(targetNames: 'output', controllerName: 'host') }}
      {{ stimulus_controller('host', controllerValues: {url: path('api')}, controllerOutlets: {'peer': '#peer'}) }}`, true);
    expect(refs.references.filter((ref) => ref.kind === 'action' || ref.kind === 'target').map((ref) => ref.name)).toEqual(['go', 'output']);
    expect(refs.bindings[0]?.endpoint.name).toBe('api');
  });
  it('splits raw attributes using the longest registered host and preserves namespace separators', () => {
    const input = '<div data-admin--chat-admin--user-status-outlet="#online"></div>';
    const raw = scanFrontend(input, true).references[0]!;
    const ref = resolveOutletReference(raw, [{ name: 'admin', projectPath: 'a.js' }, { name: 'admin--chat', projectPath: 'b.js' }])!;
    expect(ref).toMatchObject({ controller: 'admin--chat', name: 'admin--user-status', selector: { name: '#online' } });
    expect(input.slice(ref.range.start, ref.range.end)).toBe('admin--user-status');
  });
  it('keeps dynamic selectors unknown and ignores commented or example markup', () => {
    const input = `<div data-host-peer-outlet="{{ selector }}"></div>
      {{ stimulus_controller('host', controllerOutlets: {'peer': selector, 'other': '#id' ~ suffix}) }}
      {# <div data-host-hidden-outlet="#id"></div> #}
      {% verbatim %}{{ stimulus_controller('fake', {}, {}, {'peer': '#id'}) }}{% endverbatim %}
      <!-- <div data-host-hidden-outlet="#id"></div> -->
      <script>const sample = '<div data-host-hidden-outlet="#id">';</script>`;
    const refs = scanFrontend(input, true).references.filter((ref) => ref.kind === 'outlet');
    expect(refs).toHaveLength(3);
    expect(refs.every((ref) => !ref.selector)).toBe(true);
  });
  it('refreshes cached declarations when a controller changes or is deleted', () => {
    const index = new FrontendIndex();
    index.update('assets/host_controller.ts', source);
    expect(index.get('assets/host_controller.ts')?.stimulus?.outlets[0]?.name).toBe('admin--user-status');
    index.update('assets/host_controller.ts', source.replace('admin--user-status', 'peer'));
    expect(index.get('assets/host_controller.ts')?.stimulus?.outlets[0]?.name).toBe('peer');
    index.remove('assets/host_controller.ts');
    expect(index.get('assets/host_controller.ts')).toBeUndefined();
  });
});
