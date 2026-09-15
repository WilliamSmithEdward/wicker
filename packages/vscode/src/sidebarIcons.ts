import type { PhpTypeDeclaration } from '@wicker/core';
import * as vscode from 'vscode';

/**
 * One hue per row family, from colours every theme defines.
 *
 * The editor colours only its `symbol-*` codicons on its own, from a pastel
 * palette whose blues sit close together, so a controller came out orange
 * beside a grey folder, a grey route and a grey leaf.
 *
 * Where a convention exists the hue follows it, because a reader arrives
 * already knowing it: JavaScript is yellow and TypeScript blue in every file
 * icon theme, PHP's own colour is purple, Twig's is green. Where none exists
 * the hue says what the row does: a template route leads to a template and is
 * green like one, an API route answers with JSON and is cyan, a component is
 * red, Stimulus is orange. The hues are the theme's chart and terminal
 * colours, defined in light, dark and high contrast alike, and a warning keeps
 * the warning colour, which is a darker yellow than the JavaScript one.
 */
const HUES = {
  template: 'charts.green',
  templateRoute: 'terminal.ansiBrightGreen',
  apiRoute: 'terminal.ansiCyan',
  php: 'charts.purple',
  javascript: 'terminal.ansiBrightYellow',
  typescript: 'charts.blue',
  stylesheet: 'terminal.ansiMagenta',
  stimulus: 'charts.orange',
  component: 'charts.red',
  warning: 'list.warningForeground',
} as const;

type Hue = keyof typeof HUES;

/** One visual meaning per icon. Group icons differ from the objects they hold. */
export const SIDEBAR_ICONS = {
  project: { id: 'project' },
  controllers: { id: 'list-tree', hue: 'php' },
  controller: { id: 'symbol-class', hue: 'php' },
  method: { id: 'symbol-method', hue: 'php' },
  dependencies: { id: 'type-hierarchy-sub', hue: 'php' },
  service: { id: 'server', hue: 'php' },
  repository: { id: 'database', hue: 'php' },
  entity: { id: 'symbol-struct', hue: 'php' },
  interface: { id: 'symbol-interface', hue: 'php' },
  enum: { id: 'symbol-enum', hue: 'php' },
  class: { id: 'symbol-misc', hue: 'php' },
  templateRoutes: { id: 'list-selection', hue: 'templateRoute' },
  templateRoute: { id: 'route-leaf', hue: 'templateRoute' },
  apiRoutes: { id: 'radio-tower', hue: 'apiRoute' },
  jsonRoute: { id: 'symbol-object', hue: 'apiRoute' },
  route: { id: 'globe', hue: 'apiRoute' },
  consumer: { id: 'references', hue: 'apiRoute' },
  templates: { id: 'files', hue: 'template' },
  template: { id: 'template-leaf', hue: 'template' },
  namespace: { id: 'package', hue: 'template' },
  folder: { id: 'folder', hue: 'template' },
  included: { id: 'references', hue: 'template' },
  extended: { id: 'type-hierarchy-sub', hue: 'template' },
  scripts: { id: 'file-code', hue: 'javascript' },
  javascript: { id: 'code', hue: 'javascript' },
  typescript: { id: 'symbol-type-parameter', hue: 'typescript' },
  stylesheet: { id: 'symbol-color', hue: 'stylesheet' },
  stimulus: { id: 'plug', hue: 'stimulus' },
  stimulusJavascript: { id: 'code', hue: 'stimulus' },
  stimulusTypescript: { id: 'symbol-type-parameter', hue: 'stimulus' },
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
 * A drawn icon cannot take a theme colour, so the leaves carry the scheme's
 * own values: the template leaf the green every theme uses for charts.green,
 * the route leaf the brighter green of terminal.ansiBrightGreen, each in the
 * theme's own shade. With colours off they take the icon foreground each
 * theme gives a plain codicon.
 */
const STROKES = {
  'template-leaf': { light: '#388a34', dark: '#89d185' },
  'route-leaf': { light: '#14ce14', dark: '#23d18b' },
} as const;
const PLAIN_STROKE = { light: '#424242', dark: '#c5c5c5' } as const;

/**
 * Whether rows are coloured, read once per turn of the event loop.
 *
 * Every row asks on every draw, and a configuration snapshot per row is the
 * cost this table was built to avoid. Held for the current turn only, so a
 * setting changed between turns is never answered from the previous one; the
 * tree redraws on the change in any case.
 */
let colored: boolean | undefined;

function colorsOn(): boolean {
  if (colored === undefined) {
    colored = vscode.workspace.getConfiguration('wicker').get<boolean>('sidebar.colors', true);
    queueMicrotask(() => { colored = undefined; });
  }
  return colored;
}

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
function leafIcon(name: keyof typeof STROKES, theme: 'light' | 'dark', plain: boolean): vscode.Uri {
  const strokes = `${VEINS}${name === 'route-leaf' ? ARROW : ''}`;
  const stroke = plain ? PLAIN_STROKE[theme] : STROKES[name][theme];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
    `fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${LEAF}"/><path d="${strokes}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`);
}

/** Built once each; a tree redraw asks for these on every visible row. */
const leaves = new Map<string, { light: vscode.Uri; dark: vscode.Uri }>();

export function sidebarIcon(role: SidebarRole): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } {
  const entry: { readonly id: string; readonly hue?: Hue } = SIDEBAR_ICONS[role];
  const { id } = entry;
  const hue = colorsOn() ? entry.hue : undefined;
  if (id !== 'template-leaf' && id !== 'route-leaf') {
    return hue === undefined ? new vscode.ThemeIcon(id) : new vscode.ThemeIcon(id, new vscode.ThemeColor(HUES[hue]));
  }
  const key = `${id}:${hue === undefined ? 'plain' : 'coloured'}`;
  let drawn = leaves.get(key);
  if (drawn === undefined) {
    drawn = { light: leafIcon(id, 'light', hue === undefined), dark: leafIcon(id, 'dark', hue === undefined) };
    leaves.set(key, drawn);
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
