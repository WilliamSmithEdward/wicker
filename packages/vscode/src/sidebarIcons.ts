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
  scripts: 'code-block', javascript: 'code', typescript: 'symbol-type-parameter',
} as const;

export function sidebarIcon(name: string): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } {
  const root = vscode.extensions.getExtension('WilliamSmithE.wicker')!.extensionUri;
  return name === 'template-leaf' || name === 'route-leaf'
    ? { light: vscode.Uri.joinPath(root, 'resources', `${name}-light.svg`),
      dark: vscode.Uri.joinPath(root, 'resources', `${name}-dark.svg`) }
    : new vscode.ThemeIcon(name);
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
