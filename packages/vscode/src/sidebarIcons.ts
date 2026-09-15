import type { PhpTypeDeclaration } from '@wicker/core';
import * as vscode from 'vscode';

/**
 * One hue per row family, from colours every theme defines.
 *
 * The editor colours only its `symbol-*` codicons on its own, from a pastel
 * palette whose blues sit close together, so a controller came out orange
 * beside a grey folder, a grey route and a grey leaf and two kinds of blue
 * row could not be told apart. Every row now takes its hue from what it is,
 * and the eight hues are chosen to stay apart in light, dark and high
 * contrast: the chart palette for six of them and two terminal colours for
 * the rest. A warning keeps the warning colour, and yellow is otherwise given
 * only to stylesheets, which never sit beside a warning.
 */
const HUES = {
  template: 'charts.green',
  php: 'charts.orange',
  action: 'charts.purple',
  route: 'charts.blue',
  script: 'terminal.ansiCyan',
  stimulus: 'terminal.ansiMagenta',
  stylesheet: 'charts.yellow',
  component: 'charts.red',
  warning: 'list.warningForeground',
} as const;

type Hue = keyof typeof HUES;

/** One visual meaning per icon. Group icons differ from the objects they hold. */
export const SIDEBAR_ICONS = {
  project: { id: 'project' },
  controllers: { id: 'list-tree', hue: 'php' },
  controller: { id: 'symbol-class', hue: 'php' },
  dependencies: { id: 'type-hierarchy-sub', hue: 'php' },
  service: { id: 'server', hue: 'php' },
  repository: { id: 'database', hue: 'php' },
  entity: { id: 'symbol-struct', hue: 'php' },
  interface: { id: 'symbol-interface', hue: 'php' },
  enum: { id: 'symbol-enum', hue: 'php' },
  class: { id: 'symbol-misc', hue: 'php' },
  method: { id: 'symbol-method', hue: 'action' },
  templateRoutes: { id: 'list-selection', hue: 'route' },
  templateRoute: { id: 'route-leaf', hue: 'route' },
  apiRoutes: { id: 'radio-tower', hue: 'route' },
  jsonRoute: { id: 'symbol-object', hue: 'route' },
  route: { id: 'globe', hue: 'route' },
  consumer: { id: 'references', hue: 'route' },
  templates: { id: 'files', hue: 'template' },
  template: { id: 'template-leaf', hue: 'template' },
  namespace: { id: 'package', hue: 'template' },
  folder: { id: 'folder', hue: 'template' },
  included: { id: 'references', hue: 'template' },
  extended: { id: 'type-hierarchy-sub', hue: 'template' },
  scripts: { id: 'file-code', hue: 'script' },
  javascript: { id: 'code', hue: 'script' },
  typescript: { id: 'symbol-type-parameter', hue: 'script' },
  stylesheet: { id: 'symbol-color', hue: 'stylesheet' },
  stimulus: { id: 'plug', hue: 'stimulus' },
  action: { id: 'symbol-event', hue: 'stimulus' },
  target: { id: 'symbol-field', hue: 'stimulus' },
  value: { id: 'symbol-variable', hue: 'stimulus' },
  cssClass: { id: 'symbol-color', hue: 'stimulus' },
  outlet: { id: 'link', hue: 'stimulus' },
  actionParam: { id: 'symbol-parameter', hue: 'stimulus' },
  components: { id: 'extensions', hue: 'component' },
  component: { id: 'tag', hue: 'component' },
  warning: { id: 'warning', hue: 'warning' },
  retry: { id: 'refresh' },
  settings: { id: 'settings-gear' },
} as const satisfies Record<string, { id: string; hue?: Hue }>;

export type SidebarRole = keyof typeof SIDEBAR_ICONS;

/*
 * The leaf, drawn once rather than kept as four near-identical files.
 *
 * The route form is the same leaf with an arrow leaving it, and the two themes
 * differ only in stroke colour, so a file per combination was three copies of
 * one drawing waiting to drift apart.
 */
const LEAF = 'M5.5 17.5C3 14.5 4.2 9.5 8 7c3.4-2.3 8.2-2.2 12-4-.1 4.6-.4 9.5-3.9 12.7-2.7 2.5-6.9 3.6-10.6 1.8Z';
const VEINS = 'M4 21c2.6-5.2 6.3-8.9 11-12M9 14.5l.5-4M9 14.5l4.5-.5';
const ARROW = 'M13 21h9m-3-3 3 3-3 2';

/**
 * A drawn icon cannot take a theme colour, so the leaf carries the scheme's
 * own values: the template leaf the green every theme uses for charts.green
 * and the route leaf its blue, in each theme's own shade.
 */
const STROKES = {
  'template-leaf': { light: '#388a34', dark: '#89d185' },
  'route-leaf': { light: '#1a85ff', dark: '#3794ff' },
} as const;

/**
 * The icon as a data URI, rather than a file inside the extension.
 *
 * A tree icon addressed by file URI is resolved against the window, not the
 * extension host, so over a remote connection it points at a path on the wrong
 * machine and silently draws nothing. A data URI carries the image itself and
 * is passed through untouched, so it draws wherever the window is running.
 *
 * Base64 rather than percent-encoding, because the `#` beginning each colour
 * would otherwise start a URI fragment and truncate the image.
 */
function leafIcon(name: keyof typeof STROKES, theme: 'light' | 'dark'): vscode.Uri {
  const strokes = `${VEINS}${name === 'route-leaf' ? ARROW : ''}`;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
    `fill="none" stroke="${STROKES[name][theme]}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${LEAF}"/><path d="${strokes}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`);
}

/** Built once each; a tree redraw asks for these on every visible row. */
const leaves = new Map<string, { light: vscode.Uri; dark: vscode.Uri }>();

export function sidebarIcon(role: SidebarRole): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } {
  const entry: { readonly id: string; readonly hue?: Hue } = SIDEBAR_ICONS[role];
  const { id, hue } = entry;
  if (id !== 'template-leaf' && id !== 'route-leaf') {
    return hue === undefined ? new vscode.ThemeIcon(id) : new vscode.ThemeIcon(id, new vscode.ThemeColor(HUES[hue]));
  }
  let drawn = leaves.get(id);
  if (drawn === undefined) {
    drawn = { light: leafIcon(id, 'light'), dark: leafIcon(id, 'dark') };
    leaves.set(id, drawn);
  }
  return drawn;
}

/** Namespace roles are presentation hints, not claims about container wiring. */
export function dependencyKind(type: PhpTypeDeclaration): 'service' | 'repository' | 'entity' | PhpTypeDeclaration['kind'] {
  if (type.kind !== 'class') { return type.kind; }
  const namespaces = type.name.toLowerCase().split('\\').slice(0, -1);
  if (namespaces.includes('repository')) { return 'repository'; }
  if (namespaces.includes('entity')) { return 'entity'; }
  if (namespaces.includes('service')) { return 'service'; }
  return 'class';
}
