import * as vscode from 'vscode';

import { joinProjectPath, parseTemplateName, type LoaderPathEntry, type LoaderPathSource, type RenderingController, type RenderSite } from '@wicker/core';

import { enginePathOf } from './paths.js';
import type { ProjectSession, SessionManager } from './session.js';

const SHOW_BUNDLES_KEY = 'wicker.sidebar.showBundleTemplates';
type WarningReason = 'namespaces' | 'indexLimit';
type ControllerIdentity = { readonly root: vscode.Uri; readonly projectPath: string; readonly className: string };
type ControllerNode = ControllerIdentity & (
  | { readonly kind: 'controller' }
  | { readonly kind: 'controllerMethod'; readonly methodName: string }
  | { readonly kind: 'controllerTemplate'; readonly methodName: string; readonly name: string }
);

export type SidebarNode =
  | { readonly kind: 'project'; readonly root: vscode.Uri }
  | { readonly kind: 'section'; readonly root: vscode.Uri; readonly section: 'controllers' | 'templates' }
  | ControllerNode
  | { readonly kind: 'warning'; readonly root: vscode.Uri; readonly reason: WarningReason }
  | { readonly kind: 'action'; readonly root: vscode.Uri; readonly reason: WarningReason; readonly action: 'retry' | 'settings' }
  | { readonly kind: 'namespace'; readonly root: vscode.Uri; readonly namespace: string }
  | { readonly kind: 'folder'; readonly root: vscode.Uri; readonly namespace: string; readonly path: string }
  | { readonly kind: 'template'; readonly root: vscode.Uri; readonly name: string };

const NAMESPACE_SOURCES: Record<LoaderPathSource, { label: string; detail: string }> = {
  console: {
    label: 'Symfony console',
    detail: 'Namespaces read from Symfony, including those registered by bundles.',
  },
  remembered: {
    label: 'Saved from Symfony',
    detail: 'Using an earlier Symfony answer. New or removed bundle namespaces may have changed.',
  },
  config: {
    label: 'Configuration only',
    detail: 'Using twig.yaml. Bundle namespaces need the Symfony console. Check Wicker console settings.',
  },
};

/** The tree holds identifiers; each query reads the session's current index. */
export class ProjectTreeProvider implements vscode.TreeDataProvider<SidebarNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SidebarNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private renderRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly sessions: SessionManager, private showBundles = false) {
    this.subscriptions = [
      sessions.onDidChange(() => this.refresh()),
      sessions.onDidChangeRenderSites(() => {
        if (this.renderRefreshTimer === undefined) {
          this.renderRefreshTimer = setTimeout(() => {
            this.renderRefreshTimer = undefined;
            this.refresh();
          }, 50);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('wicker.enable')) {
          this.refresh();
        }
      }),
    ];
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  setShowBundleTemplates(show: boolean): void {
    if (this.showBundles !== show) {
      this.showBundles = show;
      this.refresh();
    }
  }

  isTemplateVisible(root: vscode.Uri, name: string): boolean {
    const session = this.sessionForRoot(root);
    return session !== undefined && this.isNamespaceVisible(session, namespaceOf(name));
  }

  private isNamespaceVisible(session: ProjectSession, namespace: string): boolean {
    return this.showBundles || !isBundleNamespace(session.loaderPaths.paths.all(), namespace);
  }

  getChildren(node?: SidebarNode): SidebarNode[] {
    if (node === undefined) {
      return this.sessions.all().flatMap((session) => {
        const root = session.fileSystem.toUri(session.project.root);
        return this.sessions.sessionFor({ uri: root }) === session
          ? [{ kind: 'project' as const, root }] : [];
      });
    }
    const session = this.sessionForRoot(node.root);
    if (session === undefined) {
      return [];
    }
    if (node.kind === 'project') {
      return [
        ...warningReasons(session).map((reason) => ({ kind: 'warning' as const, root: node.root, reason })),
        { kind: 'section', root: node.root, section: 'controllers' },
        { kind: 'section', root: node.root, section: 'templates' },
      ];
    }
    if (node.kind === 'section' && node.section === 'controllers') {
      return controllersInProject(this.sessions, session).map(({ projectPath, className }) => ({
        kind: 'controller', root: node.root, projectPath, className,
      }));
    }
    if (node.kind === 'controller' || node.kind === 'controllerMethod') {
      const sites = controllerSites(this.sessions, session, node);
      if (node.kind === 'controller') {
        return [...new Set(sites.map((site) => site.methodName!))].map((methodName) => ({
          ...node, kind: 'controllerMethod', methodName,
        }));
      }
      return [...new Set(sites.map((site) => site.templateName))].map((name) => ({
        ...node, kind: 'controllerTemplate', name,
      }));
    }
    if (node.kind === 'section' && node.section === 'templates') {
      const namespaces = new Set(session.index.allNames().map(namespaceOf));
      for (const entry of session.loaderPaths.paths.all()) {
        namespaces.add(namespaceKey(entry.namespace, entry.forcesBundleTemplate));
      }
      return [...namespaces].filter((namespace) => this.isNamespaceVisible(session, namespace)).sort().map((namespace) => ({
        kind: 'namespace' as const, root: node.root, namespace,
      }));
    }
    if (node.kind === 'warning') {
      return warningReasons(session).includes(node.reason)
        ? [
          { kind: 'action', root: node.root, reason: node.reason, action: 'retry' },
          { kind: 'action', root: node.root, reason: node.reason, action: 'settings' },
        ] : [];
    }
    if (node.kind === 'namespace' || node.kind === 'folder') {
      if (!this.isNamespaceVisible(session, node.namespace)) {
        return [];
      }
      const prefix = node.kind === 'folder' ? `${node.path}/` : '';
      const folders = new Set<string>();
      const templates: SidebarNode[] = [];
      for (const name of namesInGroup(session, node.namespace)) {
        const path = templatePath(name);
        if (!path.startsWith(prefix)) {
          continue;
        }
        const slash = path.indexOf('/', prefix.length);
        if (slash === -1) {
          templates.push({ kind: 'template', root: node.root, name });
        } else {
          folders.add(path.slice(0, slash));
        }
      }
      // The index orders template names; put folders before files, as Explorer does.
      return [
        ...[...folders].sort().map((path) => ({
          kind: 'folder' as const, root: node.root, namespace: node.namespace, path,
        })),
        ...templates,
      ];
    }
    return [];
  }

  getParent(node: SidebarNode): SidebarNode | undefined {
    if (node.kind === 'project') {
      return undefined;
    }
    if (node.kind === 'action') {
      return { kind: 'warning', root: node.root, reason: node.reason };
    }
    if (node.kind === 'namespace' || node.kind === 'controller') {
      return { kind: 'section', root: node.root, section: node.kind === 'namespace' ? 'templates' : 'controllers' };
    }
    if (node.kind === 'controllerMethod') {
      return { kind: 'controller', root: node.root, projectPath: node.projectPath, className: node.className };
    }
    if (node.kind === 'controllerTemplate') {
      return {
        kind: 'controllerMethod', root: node.root, projectPath: node.projectPath,
        className: node.className, methodName: node.methodName,
      };
    }
    if (node.kind === 'template' || node.kind === 'folder') {
      const namespace = node.kind === 'template' ? namespaceOf(node.name) : node.namespace;
      const path = node.kind === 'template' ? templatePath(node.name) : node.path;
      const slash = path.lastIndexOf('/');
      return slash === -1
        ? { kind: 'namespace', root: node.root, namespace }
        : { kind: 'folder', root: node.root, namespace, path: path.slice(0, slash) };
    }
    return { kind: 'project', root: node.root };
  }

  private sessionForRoot(root: vscode.Uri): ProjectSession | undefined {
    const session = this.sessions.sessionFor({ uri: root });
    return session?.fileSystem.toUri(session.project.root).toString() === root.toString()
      ? session : undefined;
  }

  getTreeItem(node: SidebarNode): vscode.TreeItem {
    const session = this.sessionForRoot(node.root);
    if (session === undefined) {
      return new vscode.TreeItem('Project unavailable');
    }
    const item = this.describe(node, session);
    item.id = nodeId(node);
    item.contextValue = `wicker.${node.kind}`;
    // Without an explicit accessible name, VS Code reads the path-heavy tooltip
    // instead of the visible namespace or project label.
    item.accessibilityInformation = {
      label: [typeof item.label === 'string' ? item.label : item.label?.label,
        typeof item.description === 'string' ? item.description : undefined].filter(Boolean).join(', '),
    };
    return item;
  }

  private describe(node: SidebarNode, session: ProjectSession): vscode.TreeItem {
    if (node.kind === 'section') {
      const controllers = node.section === 'controllers';
      const count = controllers ? controllersInProject(this.sessions, session).length :
        new Set(session.index.allNames().filter((name) => this.isNamespaceVisible(session, namespaceOf(name)))
          .map((name) => session.lookup(name)?.projectPath)).size;
      const item = new vscode.TreeItem(controllers ? 'Controllers' : 'Templates',
        controllers && count === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(controllers ? 'symbol-class' : 'files');
      item.description = String(count);
      item.tooltip = controllers
        ? 'Controllers with literal render calls or #[Template] attributes. Expand a controller to browse its actions and templates.'
        : 'Templates grouped by namespace and folder.';
      return item;
    }
    if (isControllerNode(node)) {
      const sites = controllerSites(this.sessions, session, node);
      const controller = node.kind === 'controller';
      const template = node.kind === 'controllerTemplate';
      const item = new vscode.TreeItem(template ? node.name : controller ? node.className.split('\\').at(-1)! : `${node.methodName}()`,
        template || sites.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon(template ? 'file-code' : controller ? 'symbol-class' : 'symbol-method');
      item.tooltip = `${node.className}${controller ? '' : `::${node.methodName}()`}\n${node.projectPath}`;
      if (!template) {
        item.description = String(new Set(sites.map((site) => controller ? site.methodName : site.templateName)).size);
        item.tooltip += controller ? '\nOpen controller file.' : '\nOpen the first render call or #[Template] attribute. Actions follow source order.';
        item.resourceUri = session.fileSystem.toUri(joinProjectPath(session.project.root, node.projectPath));
      } else {
        const resolved = session.lookup(node.name);
        item.tooltip = `${node.name}\n${resolved?.projectPath ?? 'This template name could not be resolved with the current index.'}`;
        if (resolved === undefined) {
          item.description = 'Unresolved';
          item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        } else {
          item.resourceUri = session.uriFor(resolved);
        }
      }
      if (sites.length > 0 && (!template || session.lookup(node.name) !== undefined)) {
        item.command = {
          command: 'wicker.openController', title: template ? 'Open template' : controller ? 'Open controller' : 'Open render call',
          arguments: [node],
        };
      }
      return item;
    }
    if (node.kind === 'project') {
      const label = vscode.workspace.getWorkspaceFolder(node.root)?.name ??
        enginePathOf(node.root).split('/').at(-1) ?? 'Symfony project';
      const item = new vscode.TreeItem(label, this.sessions.all().length === 1
        ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      const visibleFiles = new Set(session.index.allNames()
        .filter((name) => this.isNamespaceVisible(session, namespaceOf(name)))
        .map((name) => session.lookup(name)?.projectPath)).size;
      item.iconPath = new vscode.ThemeIcon('project');
      item.tooltip = `${session.project.root}\n${counted(session.index.fileCount, 'file')}, ${counted(session.index.nameCount, 'template name')}`;
      const source = NAMESPACE_SOURCES[session.loaderPaths.source];
      item.tooltip += `\nNamespaces: ${source.label}\n${source.detail}`;
      if (session.loaderPaths.consoleError !== undefined) {
        item.tooltip += `\n${session.loaderPaths.consoleError}`;
      }
      if (!this.showBundles) {
        item.tooltip += `\n${counted(visibleFiles, 'file')} shown. Bundle namespaces are hidden; use Show bundle templates to browse them.`;
      }
      if (session.index.truncated) {
        item.tooltip += '\nIndex limit reached. Increase wicker.index.maxFiles to include more templates.';
      }
      return item;
    }
    if (node.kind === 'warning') {
      const item = new vscode.TreeItem(node.reason === 'namespaces'
        ? 'Bundle namespaces unavailable' : 'Template index limit reached', vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
      item.tooltip = node.reason === 'namespaces'
        ? namespaceWarning(session)
        : 'Some templates were omitted. Increase wicker.index.maxFiles in settings, then rebuild the index.';
      return item;
    }
    if (node.kind === 'action') {
      const retry = node.action === 'retry';
      const label = retry ? 'Retry' : node.reason === 'namespaces' ? 'Open console settings' : 'Open index settings';
      const item = new vscode.TreeItem(label);
      item.iconPath = new vscode.ThemeIcon(retry ? 'refresh' : 'settings-gear');
      item.tooltip = retry ? 'Rebuild this project’s template index and retry namespace discovery.' : label;
      if (warningReasons(session).includes(node.reason)) {
        item.command = {
          command: retry ? 'wicker.retryProject' : 'wicker.openProjectSettings', title: label, arguments: [node],
        };
      }
      return item;
    }
    if (node.kind === 'namespace') {
      const names = namesInGroup(session, node.namespace);
      const item = new vscode.TreeItem(node.namespace || 'Application', names.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(names.length);
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
      const directories = session.loaderPaths.paths.all().find((entry) =>
        namespaceKey(entry.namespace, entry.forcesBundleTemplate) === node.namespace,
      )?.directories ?? [];
      item.tooltip = `${counted(names.length, 'template name')}\n${directories.join('\n')}`;
      if (names.length === 0) {
        item.tooltip += '\nAdd a template in one of these directories to see it here.';
      }
      return item;
    }
    if (node.kind === 'folder') {
      const count = namesInGroup(session, node.namespace)
        .filter((name) => templatePath(name).startsWith(`${node.path}/`)).length;
      const item = new vscode.TreeItem(basename(node.path), vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.description = String(count);
      item.tooltip = `${node.namespace ? `${node.namespace}/` : ''}${node.path}/\n${counted(count, 'template name')}`;
      return item;
    }
    const template = session.lookup(node.name);
    const item = new vscode.TreeItem(basename(templatePath(node.name)));
    item.iconPath = new vscode.ThemeIcon('file-code');
    if (template !== undefined) {
      item.resourceUri = session.uriFor(template);
      item.tooltip = `${node.name}\n${template.projectPath}`;
      const shadowed = session.index.candidatesFor(node.name).filter((entry) => entry.shadowed);
      if (shadowed.length > 0) {
        item.tooltip += `\nOverrides: ${shadowed.map((entry) => entry.projectPath).join(', ')}`;
      }
      item.command = {
        command: 'wicker.openTemplate', title: 'Open template', arguments: [node.root, node.name],
      };
    }
    return item;
  }

  dispose(): void {
    if (this.renderRefreshTimer !== undefined) {
      clearTimeout(this.renderRefreshTimer);
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.changed.dispose();
  }
}

/** Native tree controls provide keyboard navigation, theme colors and accessibility. */
export class WickerSidebar implements vscode.Disposable {
  private readonly provider: ProjectTreeProvider;
  private readonly view: vscode.TreeView<SidebarNode>;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly sessions: SessionManager, private readonly workspaceState: vscode.Memento) {
    const showBundles = workspaceState.get<unknown>(SHOW_BUNDLES_KEY) === true;
    this.provider = new ProjectTreeProvider(sessions, showBundles);
    this.view = vscode.window.createTreeView('wicker.projects', {
      treeDataProvider: this.provider, showCollapseAll: true,
    });
    this.view.message = 'Detecting Symfony projects...';
    this.subscriptions = [
      this.provider, this.view,
      vscode.commands.registerCommand('wicker.openController', (node: SidebarNode) => this.openController(node)),
      vscode.commands.registerCommand('wicker.openSettings', () =>
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:WilliamSmithE.wicker')),
      vscode.commands.registerCommand('wicker.retryProject', async (node: SidebarNode) => {
        const session = this.sessionForAction(node);
        if (session === undefined) {
          return false;
        }
        await vscode.window.withProgress(
          { location: { viewId: 'wicker.projects' }, title: 'Wicker: retrying namespace discovery' },
          () => session.refresh(),
        );
        return true;
      }),
      vscode.commands.registerCommand('wicker.openProjectSettings', async (node: SidebarNode) => {
        if (this.sessionForAction(node) === undefined || node.kind !== 'action') {
          return;
        }
        await vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', {
          query: node.reason === 'namespaces' ? '@ext:WilliamSmithE.wicker console' : '@id:wicker.index.maxFiles',
          jsonEditor: false,
        });
      }),
      vscode.commands.registerCommand('wicker.openTemplate', async (root: vscode.Uri, name: string) => {
        const session = this.sessions.sessionFor({ uri: root });
        if (session?.fileSystem.toUri(session.project.root).toString() !== root.toString()) {
          return;
        }
        const template = session?.lookup(name);
        if (session !== undefined && template !== undefined) {
          await vscode.window.showTextDocument(session.uriFor(template), { preview: true });
        }
      }),
      vscode.commands.registerCommand('wicker.revealTemplate', () => this.revealActiveTemplate()),
      vscode.commands.registerCommand('wicker.showBundleTemplates', () => this.setShowBundleTemplates(true)),
      vscode.commands.registerCommand('wicker.hideBundleTemplates', () => this.setShowBundleTemplates(false)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateRevealContext()),
      this.provider.onDidChangeTreeData(() => this.updateRevealContext()),
    ];
    void vscode.commands.executeCommand('setContext', 'wicker.showBundleTemplates', showBundles);
    this.updateRevealContext();
  }

  finishLoading(): void {
    this.view.message = '';
    this.provider.refresh();
  }

  private async openController(node: SidebarNode): Promise<void> {
    if (!isControllerNode(node)) {
      return;
    }
    const session = this.sessions.sessionFor({ uri: node.root });
    if (session?.fileSystem.toUri(session.project.root).toString() !== node.root.toString() ||
      session === undefined || controllerSites(this.sessions, session, node).length === 0) {
      return;
    }
    const template = node.kind === 'controllerTemplate' ? session.lookup(node.name) : undefined;
    if (node.kind === 'controllerTemplate' && template === undefined) {
      return;
    }
    const uri = template === undefined
      ? session.fileSystem.toUri(joinProjectPath(session.project.root, node.projectPath)) : session.uriFor(template);
    const document = await vscode.workspace.openTextDocument(uri);
    // Opening a file can refresh the index. Resolve the action again so edits
    // above it cannot leave navigation pointing at its previous offset.
    const site = controllerSites(this.sessions, session, node)[0];
    if (this.sessions.sessionFor({ uri: node.root }) !== session || site === undefined ||
      (node.kind === 'controllerTemplate' && session.lookup(node.name)?.projectPath !== template?.projectPath)) {
      return;
    }
    await vscode.window.showTextDocument(document, {
      preview: true,
      ...(node.kind === 'controllerMethod' ? {
        selection: new vscode.Range(document.positionAt(site.nameRange.start), document.positionAt(site.nameRange.end)),
      } : {}),
    });
  }

  private sessionForAction(node: SidebarNode): ProjectSession | undefined {
    if (node?.kind !== 'action') {
      return undefined;
    }
    const session = this.sessions.sessionFor({ uri: node.root });
    return session?.fileSystem.toUri(session.project.root).toString() === node.root.toString() &&
      warningReasons(session).includes(node.reason) ? session : undefined;
  }

  private async setShowBundleTemplates(show: boolean): Promise<void> {
    this.provider.setShowBundleTemplates(show);
    await vscode.commands.executeCommand('setContext', 'wicker.showBundleTemplates', show);
    await this.workspaceState.update(SHOW_BUNDLES_KEY, show);
  }

  private updateRevealContext(): void {
    // A view's resource context can describe a tree row instead of the editor.
    void vscode.commands.executeCommand('setContext', 'wicker.canRevealTemplate',
      this.activeTemplateNode() !== undefined);
  }

  private activeTemplateNode(): SidebarNode | undefined {
    const document = vscode.window.activeTextEditor?.document;
    if (document === undefined) {
      return undefined;
    }
    const session = this.sessions.sessionFor(document);
    const path = session?.relativePathOf(enginePathOf(document.uri));
    if (session === undefined || path === undefined) {
      return undefined;
    }
    const root = session.fileSystem.toUri(session.project.root);
    const names = session.index.namesForProjectPath(path)
      .filter((name) => session.lookup(name)?.projectPath === path);
    // An application override may also have a bundle alias. Prefer its visible name.
    const name = names.find((name) => this.provider.isTemplateVisible(root, name)) ?? names[0];
    if (name === undefined) {
      return undefined;
    }
    return {
      kind: 'template', root, name,
    };
  }

  private async revealActiveTemplate(): Promise<boolean> {
    const node = this.activeTemplateNode();
    if (node === undefined) {
      return false;
    }
    // Explicitly revealing a bundle file opts into showing its namespace.
    if (node.kind === 'template' && !this.provider.isTemplateVisible(node.root, node.name)) {
      await this.setShowBundleTemplates(true);
    }
    await this.view.reveal(node, { select: true, focus: true });
    return true;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

function namespaceOf(name: string): string {
  const parsed = parseTemplateName(name);
  return parsed.ok ? namespaceKey(parsed.value.namespace, parsed.value.forcesBundleTemplate) : '';
}

function nodeId(node: SidebarNode): string {
  return JSON.stringify([node.root.toString(), node.kind,
    isControllerNode(node) ? [node.projectPath, node.className,
      node.kind === 'controller' ? '' : node.methodName, node.kind === 'controllerTemplate' ? node.name : '']
      : node.kind === 'section' ? node.section
      : node.kind === 'warning' ? node.reason : node.kind === 'action' ? [node.reason, node.action]
      : node.kind === 'folder' ? [node.namespace, node.path]
      : node.kind === 'namespace' ? node.namespace : node.kind === 'template' ? node.name : '']);
}

function isControllerNode(node: SidebarNode): node is ControllerNode {
  return node?.kind === 'controller' || node?.kind === 'controllerMethod' || node?.kind === 'controllerTemplate';
}

function controllersInProject(sessions: SessionManager, session: ProjectSession): readonly RenderingController[] {
  return session.renderSites.index.controllers().filter((controller) => sessions.sessionFor({
    uri: session.fileSystem.toUri(joinProjectPath(session.project.root, controller.projectPath)),
  }) === session);
}

function controllerSites(sessions: SessionManager, session: ProjectSession, node: ControllerNode): readonly RenderSite[] {
  const controller = controllersInProject(sessions, session).find((entry) =>
    entry.projectPath === node.projectPath && entry.className === node.className);
  return controller?.sites.filter((site) => node.kind === 'controller' ||
    (site.methodName === node.methodName && (node.kind !== 'controllerTemplate' || site.templateName === node.name))) ?? [];
}

function warningReasons(session: ProjectSession): WarningReason[] {
  const reasons: WarningReason[] = [];
  if (session.loaderPaths.source === 'config') {
    reasons.push('namespaces');
  }
  if (session.index.truncated) {
    reasons.push('indexLimit');
  }
  return reasons;
}

function namespaceWarning(session: ProjectSession): string {
  const detail = NAMESPACE_SOURCES.config.detail;
  if (!vscode.workspace.isTrusted) {
    return `${detail}\nConsole discovery requires a trusted workspace.`;
  }
  if (!vscode.workspace.getConfiguration('wicker').get<boolean>('console.enabled', true)) {
    return `${detail}\nConsole discovery is disabled in Wicker settings.`;
  }
  return session.loaderPaths.consoleError === undefined ? detail : `${detail}\n${session.loaderPaths.consoleError}`;
}

function templatePath(name: string): string {
  const parsed = parseTemplateName(name);
  return parsed.ok ? parsed.value.path : name;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function namespaceKey(namespace: string | null, forcesBundleTemplate: boolean): string {
  return namespace === null ? '' : `@${forcesBundleTemplate ? '!' : ''}${namespace}`;
}

function namesInGroup(session: ProjectSession, namespace: string): readonly string[] {
  return session.index.allNames().filter((name) => namespaceOf(name) === namespace);
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Symfony's @! variant identifies bundle namespaces, including custom vendor roots. */
export function isBundleNamespace(entries: readonly LoaderPathEntry[], namespace: string): boolean {
  if (namespace === '') {
    return false;
  }
  if (namespace.startsWith('@!')) {
    return true;
  }
  return entries.some((entry) => entry.namespace === namespace.slice(1) &&
    (entry.forcesBundleTemplate || entry.directories.some((directory) =>
      directory === 'vendor' || directory.startsWith('vendor/'))));
}
