import type { PhpTypeDeclaration } from '@wicker/core';
import * as vscode from 'vscode';

/** One visual meaning per icon. Group icons differ from the objects they hold. */
export const SIDEBAR_ICONS = {
  project: 'project', controllers: 'list-tree', controller: 'symbol-class',
  templateRoutes: 'list-selection', templateRoute: 'route-leaf',
  apiRoutes: 'radio-tower', jsonRoute: 'symbol-object', route: 'globe',
  templates: 'files', template: 'template-leaf', method: 'symbol-method',
  namespace: 'package', folder: 'folder', consumer: 'references',
  dependencies: 'type-hierarchy-sub', service: 'server', repository: 'database',
  entity: 'symbol-struct', interface: 'symbol-interface', enum: 'symbol-enum',
  class: 'symbol-misc',
  scripts: 'file-code', javascript: 'code', typescript: 'symbol-type-parameter',
  stylesheet: 'symbol-color',
} as const;

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
const STROKE = { light: '#424242', dark: '#c5c5c5' } as const;

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
function leafIcon(name: 'template-leaf' | 'route-leaf', theme: 'light' | 'dark'): vscode.Uri {
  const strokes = `${VEINS}${name === 'route-leaf' ? ARROW : ''}`;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
    `fill="none" stroke="${STROKE[theme]}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${LEAF}"/><path d="${strokes}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`);
}

/** Built once each; a tree redraw asks for these on every visible row. */
const leaves = new Map<string, { light: vscode.Uri; dark: vscode.Uri }>();

export function sidebarIcon(name: string): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } {
  if (name !== 'template-leaf' && name !== 'route-leaf') {
    return new vscode.ThemeIcon(name);
  }
  let drawn = leaves.get(name);
  if (drawn === undefined) {
    drawn = { light: leafIcon(name, 'light'), dark: leafIcon(name, 'dark') };
    leaves.set(name, drawn);
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
