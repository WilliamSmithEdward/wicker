import * as vscode from 'vscode';

import { parseTemplateName, type IncomingReference, type TwigTemplateIndex, type LoaderPathEntry, type LoaderPathSource, type RenderingController, type RenderSite, type SymfonyRoute, type TwigComponent, type TwigReferenceKind } from '@wicker/core';

import { enginePathOf } from './paths.js';
import { isEnabled, type ProjectSession, type SessionManager } from './session.js';
import { counted } from './text.js';
import { apiRoutes, compareRoutePaths, controllerDependencies, frontendIndex, routeAction, routeConsumers, routeRequesters, stimulusControllers, templateRoutes, templatesBinding } from './frontendProject.js';
import { dependencyKind, sidebarIcon, type SidebarRole } from './sidebarIcons.js';
import { controllerScripts, templateControllers, templateScripts, type BoundController, type BoundWiring, type RelatedScript } from './relatedScripts.js';
import { templateStyles, type RelatedStyle } from './relatedStyles.js';
import { chainChildren, templateEntrypoints, type ChainEntry } from './loadingChain.js';

const SHOW_BUNDLES_KEY = 'wicker.sidebar.showBundleTemplates';
type WarningReason = 'namespaces' | 'indexLimit' | 'console';
type SectionName = 'controllers' | 'templates' | 'api' | 'templateRoutes' | 'components' | 'stimulus';
type ControllerIdentity = { readonly root: vscode.Uri; readonly projectPath: string; readonly className: string };
type ControllerNode = ControllerIdentity & (
  | { readonly kind: 'controller' }
  | { readonly kind: 'controllerMethod'; readonly methodName: string }
  | { readonly kind: 'controllerTemplate'; readonly methodName: string; readonly name: string }
);
type ScriptOwner =
  | (ControllerIdentity & { readonly kind: 'controllerScripts' })
  | Extract<ControllerNode, { kind: 'controllerTemplate' }>
  | { readonly kind: 'template'; readonly root: vscode.Uri; readonly name: string }
  | { readonly kind: 'routeTemplate'; readonly root: vscode.Uri; readonly name: string; readonly section: 'api' | 'templateRoutes'; readonly templateName: string };

export type SidebarNode =
  | { readonly kind: 'project'; readonly root: vscode.Uri }
  | { readonly kind: 'section'; readonly root: vscode.Uri; readonly section: SectionName }
  | { readonly kind: 'route'; readonly root: vscode.Uri; readonly name: string; readonly section: 'api' | 'templateRoutes' }
  | { readonly kind: 'routeConsumer'; readonly root: vscode.Uri; readonly name: string; readonly section: 'api' | 'templateRoutes'; readonly projectPath: string; readonly offset: number }
  | { readonly kind: 'routeTemplate'; readonly root: vscode.Uri; readonly name: string; readonly section: 'api' | 'templateRoutes'; readonly templateName: string }
  | ControllerNode
  | (ControllerIdentity & { readonly kind: 'controllerDependencies' })
  | (ControllerIdentity & { readonly kind: 'controllerDependency'; readonly typeName: string })
  | (ControllerIdentity & { readonly kind: 'controllerScripts' })
  | { readonly kind: 'renderedBy'; readonly root: vscode.Uri; readonly name: string; readonly projectPath: string; readonly label: string; readonly offset: number }
  | { readonly kind: 'extendedBy'; readonly root: vscode.Uri; readonly name: string }
  | { readonly kind: 'extending'; readonly root: vscode.Uri; readonly name: string; readonly templateName: string }
  | { readonly kind: 'includedBy'; readonly root: vscode.Uri; readonly name: string }
  | { readonly kind: 'including'; readonly root: vscode.Uri; readonly name: string; readonly projectPath: string; readonly via: TwigReferenceKind }
  | { readonly kind: 'stimulusController'; readonly root: vscode.Uri; readonly name: string }
  | { readonly kind: 'stimulusUse'; readonly root: vscode.Uri; readonly name: string; readonly projectPath: string }
  | { readonly kind: 'component'; readonly root: vscode.Uri; readonly name: string }
  | { readonly kind: 'componentPart'; readonly root: vscode.Uri; readonly name: string; readonly part: 'template' | 'class' }
  | { readonly kind: 'stimulusGroup'; readonly root: vscode.Uri; readonly parent: ScriptOwner }
  | { readonly kind: 'boundController'; readonly root: vscode.Uri; readonly name: string; readonly parent: ScriptOwner }
  | { readonly kind: 'wiring'; readonly root: vscode.Uri; readonly name: string; readonly parent: ScriptOwner;
      readonly wiringKind: BoundWiring['kind']; readonly member: string; readonly event?: string;
      readonly projectPath: string; readonly offset: number }
  | { readonly kind: 'script'; readonly root: vscode.Uri; readonly projectPath: string; readonly parent: ScriptOwner }
  | { readonly kind: 'style'; readonly root: vscode.Uri; readonly projectPath: string; readonly parent: ScriptOwner }
  | { readonly kind: 'loaded'; readonly root: vscode.Uri; readonly projectPath: string; readonly reason: string; readonly parent: SidebarNode }
  | { readonly kind: 'warning'; readonly root: vscode.Uri; readonly reason: WarningReason }
  | { readonly kind: 'action'; readonly root: vscode.Uri; readonly reason: WarningReason; readonly action: 'retry' | 'settings' }
  | { readonly kind: 'namespace'; readonly root: vscode.Uri; readonly namespace: string }
  | { readonly kind: 'folder'; readonly root: vscode.Uri; readonly namespace: string; readonly path: string }
  | { readonly kind: 'template'; readonly root: vscode.Uri; readonly name: string };

/** Stimulus' own names for the attributes, as the docs write them. */
const WIRING_LABELS: Record<BoundWiring['kind'], string> = {
  action: 'Action', target: 'Target', value: 'Value', class: 'Class', outlet: 'Outlet', actionParam: 'Param',
};
const WIRING_ICONS: Record<BoundWiring['kind'], SidebarRole> = {
  action: 'action', target: 'target', value: 'value', class: 'cssClass', outlet: 'outlet', actionParam: 'actionParam',
};

/** What a template did, in the words of the tag it used. */
const REFERENCE_VERBS: Record<TwigReferenceKind, string> = {
  'extends': 'Extends', 'include': 'Includes', 'include-function': 'Includes', 'embed': 'Embeds',
  'use': 'Uses blocks from', 'import': 'Imports macros from', 'from': 'Imports macros from',
  'source-function': 'Reads the source of',
};

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

  /**
   * How many files the visible namespaces between them provide.
   *
   * Files rather than names, because a directory registered under two
   * namespaces provides the same file twice and counting names would report a
   * project as holding more templates than it has.
   */
  private visibleFileCount(session: ProjectSession): number {
    const paths = new Set<string | undefined>();
    for (const [namespace, names] of groupsOf(session.index)) {
      if (!this.isNamespaceVisible(session, namespace)) { continue; }
      for (const name of names) { paths.add(session.lookup(name)?.projectPath); }
    }
    return paths.size;
  }

  async getChildren(node?: SidebarNode): Promise<SidebarNode[]> {
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
        ...(templateRoutes(this.sessions, session).length ? [{ kind: 'section' as const, root: node.root, section: 'templateRoutes' as const }] : []),
        ...(apiRoutes(this.sessions, session).length ? [{ kind: 'section' as const, root: node.root, section: 'api' as const }] : []),
        // Only where the project has them. A section reading zero on every
        // project that never installed the bundle is a row that never helps.
        ...(componentsInProject(session).length ? [{ kind: 'section' as const, root: node.root, section: 'components' as const }] : []),
        ...(stimulusControllers(this.sessions, session).length ? [{ kind: 'section' as const, root: node.root, section: 'stimulus' as const }] : []),
        { kind: 'section', root: node.root, section: 'templates' },
      ];
    }
    if (node.kind === 'section' && node.section === 'components') {
      return componentsInProject(session).map((component) => ({ kind: 'component' as const, root: node.root, name: component.name }));
    }
    if (node.kind === 'section' && node.section === 'stimulus') {
      return stimulusControllers(this.sessions, session).map((controller) => ({
        kind: 'stimulusController' as const, root: node.root, name: controller.name,
      }));
    }
    if (node.kind === 'component') {
      const component = componentsInProject(session).find((entry) => entry.name === node.name);
      if (component === undefined) { return []; }
      return [
        ...(session.lookup(component.template) ? [{ kind: 'componentPart' as const, root: node.root, name: node.name, part: 'template' as const }] : []),
        ...(componentClassPath(this.sessions, session, component) ? [{ kind: 'componentPart' as const, root: node.root, name: node.name, part: 'class' as const }] : []),
      ];
    }
    if (node.kind === 'stimulusController') {
      return templatesBinding(this.sessions, session, node.name).map((projectPath) => ({
        kind: 'stimulusUse' as const, root: node.root, name: node.name, projectPath,
      }));
    }
    if (node.kind === 'includedBy') {
      return includingTemplates(this.sessions, session, node.name).map((entry) => ({
        kind: 'including' as const, root: node.root, name: node.name, projectPath: entry.projectPath, via: entry.kind,
      }));
    }
    if (node.kind === 'section' && (node.section === 'api' || node.section === 'templateRoutes')) {
      const section = node.section;
      const routes = section === 'api' ? apiRoutes(this.sessions, session) : templateRoutes(this.sessions, session);
      return routes.map((route) => ({ kind: 'route', root: node.root, name: route.name, section }));
    }
    if (node.kind === 'route') {
      const route = session.frontend.routes.find((route) => route.name === node.name);
      return !route ? [] : [
        ...(routeAction(this.sessions, session, route)?.action.templates ?? []).map((templateName) => ({
          kind: 'routeTemplate' as const, root: node.root, name: node.name, section: node.section, templateName })),
        ...routeConsumers(this.sessions, session, route).map((use) => ({ kind: 'routeConsumer' as const,
          root: node.root, name: node.name, section: node.section, projectPath: use.projectPath, offset: use.range.start })),
      ];
    }
    if (node.kind === 'loaded') {
      return chainChildren(this.sessions, session, node.projectPath).map((entry) => ({
        kind: 'loaded' as const, root: node.root, projectPath: entry.projectPath, reason: entry.reason, parent: node,
      }));
    }
    if (node.kind === 'extendedBy') {
      return extendingTemplates(this.sessions, session, node.name).map((templateName) => ({
        kind: 'extending' as const, root: node.root, name: node.name, templateName,
      }));
    }
    if (node.kind === 'stimulusGroup') {
      return templateControllers(this.sessions, session, templatesForOwner(this.sessions, session, node.parent))
        .map((controller) => ({ kind: 'boundController' as const, root: node.root, name: controller.name, parent: node.parent }));
    }
    if (node.kind === 'boundController') {
      return (boundControllerFor(this.sessions, session, node)?.wiring ?? []).map((wire) => ({
        kind: 'wiring' as const, root: node.root, name: node.name, parent: node.parent,
        wiringKind: wire.kind, member: wire.name, projectPath: wire.projectPath, offset: wire.offset,
        ...(wire.event === undefined ? {} : { event: wire.event }),
      }));
    }
    if (isScriptOwner(node)) {
      return [
        ...incomingTemplateRows(this.sessions, session, node),
        // What the page runs, named the way the markup names it, before the
        // files that carry it.
        ...(templateControllers(this.sessions, session, templatesForOwner(this.sessions, session, node)).length
          ? [{ kind: 'stimulusGroup' as const, root: node.root, parent: node }] : []),
        ...(await scriptsForOwner(this.sessions, session, node)).map((script) => ({
          kind: 'script' as const, root: node.root, projectPath: script.projectPath, parent: node,
        })),
        // Stylesheets after scripts, since the link almost always sits in a
        // layout rather than the page and is the less expected of the two.
        ...(await stylesForOwner(this.sessions, session, node)).map((style) => ({
          kind: 'style' as const, root: node.root, projectPath: style.projectPath, parent: node,
        })),
        // The chain the page actually loads, expandable one import at a time.
        // Flat lists answer what; this answers why.
        ...entrypointsForOwner(this.sessions, session, node).map((entry) => ({
          kind: 'loaded' as const, root: node.root, projectPath: entry.projectPath, reason: entry.reason, parent: node,
        })),
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
        const actions = controllerActionMethods(this.sessions, session, node).map((methodName) => ({
          methodName, route: controllerRoutes(this.sessions, session, { ...node, methodName })[0],
        }));
        actions.sort((left, right) => left.route && right.route ? compareRoutePaths(left.route, right.route) :
          left.route ? -1 : right.route ? 1 : 0);
        return [
          ...actions.map(({ methodName }) => ({ ...node, kind: 'controllerMethod' as const, methodName })),
          ...(controllerDependencies(this.sessions, session, node).length
            ? [{ ...node, kind: 'controllerDependencies' as const }] : []),
          ...((await controllerScripts(this.sessions, session, node)).length
            ? [{ ...node, kind: 'controllerScripts' as const }] : []),
        ];
      }
      return [...new Set(sites.map((site) => site.templateName))].map((name) => ({
        ...node, kind: 'controllerTemplate', name,
      }));
    }
    if (node.kind === 'controllerDependencies') {
      return controllerDependencies(this.sessions, session, node).map((dependency) => ({
        ...node, kind: 'controllerDependency', typeName: dependency.declaration.name,
      }));
    }
    if (node.kind === 'section' && node.section === 'templates') {
      const namespaces = new Set(groupsOf(session.index).keys());
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
    if (node.kind === 'renderedBy' || node.kind === 'extendedBy' || node.kind === 'includedBy') {
      return { kind: 'template', root: node.root, name: node.name };
    }
    if (node.kind === 'extending') { return { kind: 'extendedBy', root: node.root, name: node.name }; }
    if (node.kind === 'including') { return { kind: 'includedBy', root: node.root, name: node.name }; }
    if (node.kind === 'componentPart') { return { kind: 'component', root: node.root, name: node.name }; }
    if (node.kind === 'stimulusUse') { return { kind: 'stimulusController', root: node.root, name: node.name }; }
    if (node.kind === 'component' || node.kind === 'stimulusController') {
      return { kind: 'section', root: node.root, section: node.kind === 'component' ? 'components' : 'stimulus' };
    }
    if (node.kind === 'boundController') { return { kind: 'stimulusGroup', root: node.root, parent: node.parent }; }
    if (node.kind === 'wiring') { return { kind: 'boundController', root: node.root, name: node.name, parent: node.parent }; }
    if (node.kind === 'script' || node.kind === 'style' || node.kind === 'stimulusGroup') { return node.parent; }
    if (node.kind === 'loaded') { return node.parent; }
    if (node.kind === 'route') { return { kind: 'section', root: node.root, section: node.section }; }
    if (node.kind === 'routeConsumer' || node.kind === 'routeTemplate') { return { kind: 'route', root: node.root, name: node.name, section: node.section }; }
    if (node.kind === 'project') {
      return undefined;
    }
    if (node.kind === 'action') {
      return { kind: 'warning', root: node.root, reason: node.reason };
    }
    if (node.kind === 'namespace' || node.kind === 'controller') {
      return { kind: 'section', root: node.root, section: node.kind === 'namespace' ? 'templates' : 'controllers' };
    }
    if (node.kind === 'controllerDependency') {
      return { kind: 'controllerDependencies', root: node.root, projectPath: node.projectPath, className: node.className };
    }
    if (node.kind === 'controllerMethod' || node.kind === 'controllerDependencies' || node.kind === 'controllerScripts') {
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

  async getTreeItem(node: SidebarNode): Promise<vscode.TreeItem> {
    const session = this.sessionForRoot(node.root);
    if (session === undefined) {
      return new vscode.TreeItem('Project unavailable');
    }
    const item = await this.describe(node, session);
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

  /**
   * A mounted controller and the attributes wiring it to the markup.
   *
   * The wiring is spread across elements and often across files: a page's
   * bindings and its layout's are one behaviour at runtime, and neither file
   * shows the other. Each row opens the attribute itself, which is the part a
   * reader cannot find by opening the file they are already looking at.
   */
  private describeWiring(node: Extract<SidebarNode, { kind: 'boundController' | 'wiring' }>,
    session: ProjectSession): vscode.TreeItem {
    const controller = boundControllerFor(this.sessions, session, node);
    if (node.kind === 'boundController') {
      const item = new vscode.TreeItem(node.name, controller?.wiring.length
        ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      if (controller === undefined) { return item; }
      item.iconPath = sidebarIcon(stimulusScriptIcon(controller.projectPath));
      // Where the attribute is, because a binding inherited from a layout is
      // not in the file the reader started from.
      item.description = controller.boundIn.join(', ');
      item.tooltip = `${controller.projectPath}\n\nBound in:\n${controller.boundIn.join('\n')}`;
      return opens(item, session.uriOf(controller.projectPath), 'Open controller');
    }
    const wire = wiringFor(this.sessions, session, node);
    const item = new vscode.TreeItem(node.event === undefined ? node.member : `${node.event} → ${node.member}`);
    if (wire === undefined || controller === undefined) { return item; }
    // An implied event is not in the attribute, so the row has to say that the
    // event it shows was never written there. Where the binding is written
    // matters once every occurrence has a row: two rows with the same name are
    // two places, and the file is what tells them apart.
    item.description = [WIRING_LABELS[wire.kind], wire.impliedEvent ? 'default event' : undefined,
      wire.projectPath === templateOwnerPath(session, node.parent) ? undefined : basename(wire.projectPath),
    ].filter(Boolean).join(' · ');
    item.iconPath = sidebarIcon(WIRING_ICONS[wire.kind]);
    item.tooltip = `${WIRING_LABELS[wire.kind]} of ${node.name}${wire.selector === undefined ? '' : ` → ${wire.selector}`}\n${
      wire.projectPath}\n\nOpen where it is written.`;
    const uri = session.uriOf(wire.projectPath);
    item.resourceUri = uri;
    item.command = { command: 'wicker.openWiring', title: 'Open the attribute', arguments: [node] };
    return item;
  }

  /**
   * A component as the two files it is made of.
   *
   * A registration names a class and a template, and neither file names the
   * other: the class carries an attribute the template never sees, and an
   * anonymous component has no class at all. The row holding both is the only
   * place the pairing is written down.
   */
  private describeComponent(node: Extract<SidebarNode, { kind: 'component' | 'componentPart' }>,
    session: ProjectSession): vscode.TreeItem {
    const component = componentsInProject(session).find((entry) => entry.name === node.name);
    if (component === undefined) { return new vscode.TreeItem(node.name); }
    if (node.kind === 'component') {
      const item = new vscode.TreeItem(`<twig:${component.name}>`, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = sidebarIcon('component');
      if (component.live) { item.description = 'Live'; }
      else if (component.className === undefined) { item.description = 'Anonymous'; }
      item.tooltip = `${component.template}\n${component.className ?? 'No class; props come from the template.'}${
        component.live ? '\n\nLive component: it re-renders over HTTP.' : ''}`;
      return item;
    }
    const template = node.part === 'template' ? session.lookup(component.template) : undefined;
    const classPath = node.part === 'class' ? componentClassPath(this.sessions, session, component) : undefined;
    const path = template?.projectPath ?? classPath;
    const item = new vscode.TreeItem(path === undefined ? node.part : basename(path));
    item.description = node.part === 'template' ? 'Template' : 'Class';
    item.iconPath = node.part === 'template' ? sidebarIcon('template') : sidebarIcon('controller');
    item.tooltip = node.part === 'template' ? `${component.template}\n${path ?? ''}` : `${component.className}\n${path ?? ''}`;
    if (path === undefined) { return item; }
    return opens(item, template ? session.uriFor(template) : session.uriOf(path), 'Open file');
  }

  /**
   * A Stimulus controller and the templates that mount it.
   *
   * The identifier lives in the markup and the behaviour lives in the script,
   * and the script never names a template. Listing the templates under the
   * controller is the only way round that edge.
   */
  private describeStimulus(node: Extract<SidebarNode, { kind: 'stimulusController' | 'stimulusUse' }>,
    session: ProjectSession): vscode.TreeItem {
    if (node.kind === 'stimulusUse') {
      const uri = session.uriOf(node.projectPath);
      const item = new vscode.TreeItem(basename(node.projectPath));
      item.description = node.projectPath.slice(0, Math.max(0, node.projectPath.lastIndexOf('/')));
      item.iconPath = sidebarIcon('template');
      item.tooltip = `${node.projectPath}\n\nBinds ${node.name}.`;
      return opens(item, uri, 'Open template');
    }
    const controller = stimulusControllers(this.sessions, session).find((entry) => entry.name === node.name);
    const uses = templatesBinding(this.sessions, session, node.name);
    const item = new vscode.TreeItem(node.name, uses.length
      ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    if (controller === undefined) { return item; }
    item.description = uses.length ? counted(uses.length, 'template') : 'Unused';
    item.iconPath = sidebarIcon(stimulusScriptIcon(controller.projectPath));
    item.tooltip = `${controller.projectPath}\n\nWritten in markup as data-controller="${node.name}".${
      uses.length ? '' : '\nNo indexed template binds it.'}`;
    return opens(item, session.uriOf(controller.projectPath), 'Open controller');
  }

  private async describe(node: SidebarNode, session: ProjectSession): Promise<vscode.TreeItem> {
    if (node.kind === 'controllerScripts') {
      const item = new vscode.TreeItem('Scripts', (await this.getChildren(node)).length
        ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.iconPath = sidebarIcon('scripts');
      item.tooltip = 'Scripts associated through rendered templates, Stimulus bindings or route consumers.';
      return item;
    }
    if (node.kind === 'renderedBy') {
      const item = new vscode.TreeItem(node.label);
      item.description = 'Renders this';
      item.iconPath = sidebarIcon('method');
      item.tooltip = `${node.projectPath}

Open the render call that names ${node.name}.`;
      item.resourceUri = session.uriOf(node.projectPath);
      item.command = { command: 'wicker.openRenderedBy', title: 'Open the render call', arguments: [node] };
      return item;
    }
    if (node.kind === 'extendedBy') {
      const extending = extendingTemplates(this.sessions, session, node.name);
      const item = new vscode.TreeItem('Extended by', vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(extending.length);
      item.iconPath = sidebarIcon('extended');
      item.tooltip = `Templates that extend ${node.name}, and inherit the blocks it declares.`;
      return item;
    }
    if (node.kind === 'includedBy') {
      const item = new vscode.TreeItem('Included by', vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(includingTemplates(this.sessions, session, node.name).length);
      item.iconPath = sidebarIcon('included');
      item.tooltip = `Templates that pull ${node.name} in without extending it.`;
      return item;
    }
    if (node.kind === 'including') {
      const item = new vscode.TreeItem(basename(node.projectPath));
      item.description = REFERENCE_VERBS[node.via];
      item.iconPath = sidebarIcon('template');
      item.tooltip = `${node.projectPath}\n\n${REFERENCE_VERBS[node.via]} ${node.name}.`;
      return opens(item, session.uriOf(node.projectPath), 'Open template');
    }
    if (node.kind === 'stimulusGroup') {
      const item = new vscode.TreeItem('Stimulus', vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(templateControllers(this.sessions, session,
        templatesForOwner(this.sessions, session, node.parent)).length);
      item.iconPath = sidebarIcon('stimulus');
      item.tooltip = 'Stimulus controllers this page mounts, including those bound by its layout and includes.';
      return item;
    }
    if (node.kind === 'boundController' || node.kind === 'wiring') {
      return this.describeWiring(node, session);
    }
    if (node.kind === 'component' || node.kind === 'componentPart') {
      return this.describeComponent(node, session);
    }
    if (node.kind === 'stimulusController' || node.kind === 'stimulusUse') {
      return this.describeStimulus(node, session);
    }
    if (node.kind === 'extending') {
      const item = new vscode.TreeItem(basename(templatePath(node.templateName)));
      item.description = templatePath(node.templateName).slice(0, Math.max(0, templatePath(node.templateName).lastIndexOf('/')));
      item.iconPath = sidebarIcon('template');
      item.tooltip = `${node.templateName}

Extends ${node.name}.`;
      const target = session.lookup(node.templateName);
      if (target !== undefined) { item.resourceUri = session.uriFor(target); }
      item.command = { command: 'wicker.openTemplate', title: 'Open template', arguments: [node.root, node.templateName] };
      return item;
    }
    if (node.kind === 'script') {
      const script = (await scriptsForOwner(this.sessions, session, node.parent)).find((entry) => entry.projectPath === node.projectPath);
      const item = new vscode.TreeItem(basename(node.projectPath));
      item.description = node.projectPath.slice(0, node.projectPath.lastIndexOf('/'));
      item.iconPath = sidebarIcon(scriptIcon(node.projectPath));
      item.tooltip = `${node.projectPath}\n\n${script?.reasons.join('\n') ?? ''}${script?.generatedPaths.length
        ? `\n\nTypeScript source for:\n${script.generatedPaths.join('\n')}` : ''}`;
      item.resourceUri = session.uriOf(node.projectPath);
      if (script) { item.command = { command: 'wicker.openRelatedScript', title: 'Open associated script', arguments: [node] }; }
      return item;
    }
    if (node.kind === 'style') {
      const style = (await stylesForOwner(this.sessions, session, node.parent)).find((entry) => entry.projectPath === node.projectPath);
      const item = new vscode.TreeItem(basename(node.projectPath));
      item.description = node.projectPath.slice(0, node.projectPath.lastIndexOf('/'));
      item.iconPath = sidebarIcon('stylesheet');
      // Which template links it, because the link is usually in a layout and
      // not in the page the reader started from.
      item.tooltip = `${node.projectPath}\n\n${style?.reasons.join('\n') ?? ''}`;
      return opens(item, session.uriOf(node.projectPath), 'Open stylesheet');
    }
    if (node.kind === 'controllerDependencies' || node.kind === 'controllerDependency') {
      const dependencies = controllerDependencies(this.sessions, session, node);
      if (node.kind === 'controllerDependencies') {
        const item = new vscode.TreeItem('Dependencies', dependencies.length
          ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.iconPath = sidebarIcon('dependencies');
        item.tooltip = 'Project types declared on this controller’s parameters and properties. Select one to open its declaration.';
        return item;
      }
      const dependency = dependencies.find((entry) => entry.declaration.name === node.typeName);
      const shortName = node.typeName.split('\\').at(-1)!;
      const duplicate = dependencies.filter((entry) => entry.declaration.name.split('\\').at(-1) === shortName).length > 1;
      const item = new vscode.TreeItem(duplicate ? node.typeName : shortName);
      if (!dependency) { return item; }
      item.iconPath = sidebarIcon(dependencyKind(dependency.declaration));
      item.description = [...new Set(dependency.uses.map((use) => use.variable))].join(', ');
      item.tooltip = `${node.typeName}\n${dependency.projectPath}\n\nDeclared on:\n${[...new Set(dependency.uses.map((use) =>
        use.methodName ? `${use.methodName}() — ${use.variable}` : `Property ${use.variable}`))].join('\n')}\n\nOpen type declaration.`;
      item.resourceUri = session.uriOf(dependency.projectPath);
      item.command = { command: 'wicker.openControllerDependency', title: 'Open dependency', arguments: [node] };
      return item;
    }
    if (node.kind === 'section' && (node.section === 'api' || node.section === 'templateRoutes')) {
      const api = node.section === 'api';
      const item = new vscode.TreeItem(api ? 'API routes' : 'Template routes', vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = sidebarIcon(api ? 'apiRoutes' : 'templateRoutes');
      item.tooltip = api ? 'JSON endpoints. Expand a route to find what calls it.' :
        'Routes whose controller actions render Twig HTML. Select a route to open its PHP action, or expand it to browse rendered templates and references.';
      return item;
    }
    if (node.kind === 'route' || node.kind === 'routeConsumer' || node.kind === 'routeTemplate') {
      const route = session.frontend.routes.find((route) => route.name === node.name);
      const rowIcon = route ? routeIcon(this.sessions, session, route) : 'route';
      const label = node.kind === 'route' ? `${route?.methods ?? ''} ${route?.path ?? node.name}` :
        node.kind === 'routeTemplate' ? node.templateName : node.projectPath;
      const item = new vscode.TreeItem(label, (node.kind === 'route' || node.kind === 'routeTemplate') && (await this.getChildren(node)).length
        ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.iconPath = sidebarIcon(node.kind === 'route' ? rowIcon : node.kind === 'routeTemplate' ? 'template' :
        /\.[jt]s$/.test(node.projectPath) ? scriptIcon(node.projectPath) : node.projectPath.endsWith('.twig') ? 'template' : 'consumer');
      // A template route that script fetches is a fragment, which nothing in
      // the row would otherwise say; a JSON endpoint explains itself.
      const fetchers = node.kind === 'route' && route && rowIcon !== 'jsonRoute'
        ? routeRequesters(this.sessions, session, route) : [];
      const fetchedBy = fetchers.length === 0 ? '' : ` · fetched by ${basename(fetchers[0]!.projectPath)}${
        fetchers.length > 1 ? ` +${fetchers.length - 1}` : ''}`;
      item.description = node.kind === 'route' ? `${node.name}${fetchedBy}` : node.kind === 'routeTemplate' ? 'Renders' : 'Consumer';
      item.tooltip = node.kind === 'route' ? `${route?.controller ?? node.name}\n${fetchers.length === 0 ? '' :
        `Fetched by:\n${fetchers.map((use) => `${use.projectPath}${use.via === undefined ? '' : ` (${use.via})`}`).join('\n')}\n`
      }Open the endpoint action. Expand to explore its connections.` :
        node.kind === 'routeTemplate' ? `HTML rendered by ${node.name}` : `Explicit reference to ${node.name}\n${node.projectPath}`;
      // Each row stands for a file, and says so, so a route whose action is
      // untracked or a consumer that is modified carries its git state here
      // as it does under its controller.
      const file = node.kind === 'route' ? (route && routeAction(this.sessions, session, route)?.projectPath)
        : node.kind === 'routeConsumer' ? node.projectPath : session.lookup(node.templateName)?.projectPath;
      if (file !== undefined) { item.resourceUri = session.uriOf(file); }
      item.command = { command: 'wicker.openEndpoint', title: 'Open endpoint connection', arguments: [node] };
      return item;
    }
    if (node.kind === 'section' && (node.section === 'components' || node.section === 'stimulus')) {
      const components = node.section === 'components';
      const count = components ? componentsInProject(session).length : stimulusControllers(this.sessions, session).length;
      const item = new vscode.TreeItem(components ? 'Components' : 'Stimulus', vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = sidebarIcon(components ? 'components' : 'stimulus');
      item.description = String(count);
      item.tooltip = components
        ? 'Twig components registered with this project. Expand one to open its template or its class.'
        : 'Stimulus controllers in this project. Expand one to find the templates that mount it.';
      return item;
    }
    if (node.kind === 'section') {
      const controllers = node.section === 'controllers';
      const count = controllers ? controllersInProject(this.sessions, session).length
        : this.visibleFileCount(session);
      const item = new vscode.TreeItem(controllers ? 'Controllers' : 'Templates',
        controllers && count === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = sidebarIcon(controllers ? 'controllers' : 'templates');
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
      const routes = node.kind === 'controllerMethod' ? controllerRoutes(this.sessions, session, node) : [];
      const routeLabels = [...new Set(routes.map((route) => `${route.methods} ${route.path}`))];
      const templateNames = [...new Set(sites.map((site) => site.templateName))];
      const item = new vscode.TreeItem(template ? node.name : controller ? node.className.split('\\').at(-1)! :
        routeLabels.length ? routeLabels.join(' · ') : `${node.methodName}()`,
        (template ? (await this.getChildren(node)).length === 0 : sites.length === 0) ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
      const actionIcon = actionRouteIcon(routes.map((route) => routeIcon(this.sessions, session, route)));
      item.iconPath = sidebarIcon(template ? 'template' : controller ? 'controller' : actionIcon);
      item.tooltip = `${node.className}${controller ? '' : `::${node.methodName}()`}\n${node.projectPath}`;
      if (!template) {
        item.description = controller ? String(new Set(sites.map((site) => site.methodName)).size) :
          routes.length ? `${node.methodName}()` : templateNames.join(', ');
        if (routes.length) {
          item.tooltip += `\n\nRoutes:\n${routes.map((route) => `${route.methods} ${route.path} (${route.name})`).join('\n')}`;
        }
        if (!controller && templateNames.length) { item.tooltip += `\n\nRenders:\n${templateNames.join('\n')}`; }
        item.tooltip += controller ? '\nOpen controller file.' : '\nOpen the first render call or #[Template] attribute.';
        item.resourceUri = session.uriOf(node.projectPath);
      } else {
        const resolved = session.lookup(node.name);
        item.tooltip = `${node.name}\n${resolved?.projectPath ?? 'This template name could not be resolved with the current index.'}`;
        if (resolved === undefined) {
          item.description = 'Unresolved';
          item.iconPath = sidebarIcon('warning');
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
      const visibleFiles = this.visibleFileCount(session);
      item.iconPath = sidebarIcon('project');
      // The root, so the project row carries what the whole tree of files does.
      item.resourceUri = node.root;
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
      const item = new vscode.TreeItem(node.reason === 'namespaces' ? 'Bundle namespaces unavailable'
        : node.reason === 'console' ? 'Symfony console unavailable'
        : 'Template index limit reached', vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = sidebarIcon('warning');
      item.tooltip = node.reason === 'namespaces' ? namespaceWarning(session)
        : node.reason === 'console'
          ? `Routes, Stimulus controllers and components are read from Symfony, and this project's console did not answer. Those sections are missing rather than empty.\n\n${
            consoleWarning(session) ?? ''}\n\nWicker runs ${session.consoleCommand ?? 'php bin/console'} in the project root. Set wicker.console.command if the application runs elsewhere, such as in a container.`
          : 'Some templates were omitted. Increase wicker.index.maxFiles in settings, then rebuild the index.';
      return item;
    }
    if (node.kind === 'action') {
      const retry = node.action === 'retry';
      const label = retry ? 'Retry' : ['namespaces', 'console'].includes(node.reason) ? 'Open console settings' : 'Open index settings';
      const item = new vscode.TreeItem(label);
      item.iconPath = sidebarIcon(retry ? 'retry' : 'settings');
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
      item.iconPath = sidebarIcon('namespace');
      const directories = loaderDirectories(session, node.namespace);
      item.tooltip = `${counted(names.length, 'template name')}\n${directories.join('\n')}`;
      // With a directory to stand for, the row picks up what its files carry:
      // a namespace holding a modified template shows the modified colour, as
      // a folder does in Explorer. A namespace spread over several directories
      // stands for none of them in particular.
      if (directories.length === 1) { item.resourceUri = session.uriOf(directories[0]!); }
      if (names.length === 0) {
        item.tooltip += '\nAdd a template in one of these directories to see it here.';
      }
      return item;
    }
    if (node.kind === 'folder') {
      const count = namesInGroup(session, node.namespace)
        .filter((name) => templatePath(name).startsWith(`${node.path}/`)).length;
      const item = new vscode.TreeItem(basename(node.path), vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = sidebarIcon('folder');
      item.description = String(count);
      item.tooltip = `${node.namespace ? `${node.namespace}/` : ''}${node.path}/\n${counted(count, 'template name')}`;
      const directories = loaderDirectories(session, node.namespace);
      if (directories.length === 1) { item.resourceUri = session.uriOf(`${directories[0]!}/${node.path}`); }
      return item;
    }
    if (node.kind === 'loaded') {
      const item = new vscode.TreeItem(basename(node.projectPath),
        chainChildren(this.sessions, session, node.projectPath).length
          ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.description = node.projectPath.slice(0, node.projectPath.lastIndexOf('/'));
      item.iconPath = sidebarIcon(node.projectPath.toLowerCase().endsWith('.css')
        ? 'stylesheet' : scriptIcon(node.projectPath));
      // The reason is the point of the row: a file this deep in the chain is
      // named in no template, and "why is this loaded" is the question.
      item.tooltip = `${node.projectPath}\n\n${node.reason}`;
      return opens(item, session.uriOf(node.projectPath), 'Open file');
    }
    const template = session.lookup(node.name);
    const item = new vscode.TreeItem(basename(templatePath(node.name)), (await this.getChildren(node)).length
      ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.iconPath = sidebarIcon('template');
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
      vscode.commands.registerCommand('wicker.openControllerDependency', (node: SidebarNode) => this.openControllerDependency(node)),
      vscode.commands.registerCommand('wicker.openRelatedScript', (node: SidebarNode) => this.openRelatedScript(node)),
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
          query: ['namespaces', 'console'].includes(node.reason) ? '@ext:WilliamSmithE.wicker console' : '@id:wicker.index.maxFiles',
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
      vscode.commands.registerCommand('wicker.openEndpoint', (node: SidebarNode) => this.openEndpoint(node)),
      vscode.commands.registerCommand('wicker.openRenderedBy', (node: SidebarNode) => this.openRenderedBy(node)),
      vscode.commands.registerCommand('wicker.openWiring', (node: SidebarNode) => this.openWiring(node)),
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
  /**
   * Opens the render call itself, not just the controller holding it.
   *
   * The row is checked against the index again first: it was built from a
   * render site that may have moved or gone since, and an offset from a stale
   * row selects unrelated text rather than nothing.
   */
  private async openRenderedBy(node: SidebarNode): Promise<void> {
    if (!node || node.kind !== 'renderedBy') { return; }
    const session = this.sessions.sessionFor({ uri: node.root });
    if (!session) { return; }
    const site = renderedBy(this.sessions, session, node.name)
      .find((entry) => entry.projectPath === node.projectPath && entry.offset === node.offset);
    if (site === undefined) { return; }
    const uri = session.uriOf(node.projectPath);
    if (this.sessions.sessionFor({ uri }) !== session) { return; }
    const document = await vscode.workspace.openTextDocument(uri);
    if (this.sessions.sessionFor({ uri }) !== session) { return; }
    const at = document.positionAt(site.offset);
    await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(at, at) });
  }

  /**
   * Opens the attribute a wiring row stands for.
   *
   * Resolved from the index again after the file opens, because opening it can
   * reindex, and an offset from a row built before an edit above it selects
   * unrelated text rather than nothing.
   */
  private async openWiring(node: SidebarNode): Promise<void> {
    if (!node || node.kind !== 'wiring') { return; }
    const session = this.sessions.sessionFor({ uri: node.root });
    if (!session) { return; }
    const wire = (): BoundWiring | undefined => wiringFor(this.sessions, session, node);
    const found = wire();
    if (found === undefined) { return; }
    const uri = session.uriOf(found.projectPath);
    if (this.sessions.sessionFor({ uri }) !== session) { return; }
    const document = await vscode.workspace.openTextDocument(uri);
    const current = wire();
    if (current === undefined || current.projectPath !== found.projectPath ||
      this.sessions.sessionFor({ uri }) !== session) { return; }
    const at = document.positionAt(current.offset);
    await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(at, at) });
  }

  private async openEndpoint(node: SidebarNode): Promise<void> {
    if (!node || !['route', 'routeConsumer', 'routeTemplate'].includes(node.kind)) { return; }
    const session = this.sessions.sessionFor({ uri: node.root });
    if (!session || (node.kind !== 'route' && node.kind !== 'routeConsumer' && node.kind !== 'routeTemplate')) { return; }
    const route = session.frontend.routes.find((route) => route.name === node.name);
    if (!route) { return; }
    const action = routeAction(this.sessions, session, route);
    const use = node.kind === 'routeConsumer' ? routeConsumers(this.sessions, session, route).find((use) => use.projectPath === node.projectPath && use.range.start === node.offset) : undefined;
    const template = node.kind === 'routeTemplate' ? session.lookup(node.templateName) : undefined;
    const path = node.kind === 'route' ? action?.projectPath : node.kind === 'routeConsumer' ? use?.projectPath : template?.projectPath;
    if (!path) { return; }
    const uri = session.uriOf(path);
    if (this.sessions.sessionFor({ uri }) !== session) { return; }
    const doc = await vscode.workspace.openTextDocument(uri);
    const range = node.kind === 'route' ? routeAction(this.sessions, session, route)?.action.range : use?.range;
    if (this.sessions.sessionFor({ uri }) !== session) { return; }
    await vscode.window.showTextDocument(doc, { preview: true,
      ...(range ? { selection: new vscode.Range(doc.positionAt(range.start), doc.positionAt(range.end)) } : {}) });
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
      ? session.uriOf(node.projectPath) : session.uriFor(template);
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

  private async openControllerDependency(node: SidebarNode): Promise<void> {
    if (node?.kind !== 'controllerDependency') { return; }
    const session = this.sessions.sessionFor({ uri: node.root });
    if (!session || session.fileSystem.toUri(session.project.root).toString() !== node.root.toString()) { return; }
    const resolve = (): ReturnType<typeof controllerDependencies>[number] | undefined =>
      controllerDependencies(this.sessions, session, node).find((entry) => entry.declaration.name === node.typeName);
    const target = resolve();
    if (!target) { return; }
    const uri = session.uriOf(target.projectPath);
    const document = await vscode.workspace.openTextDocument(uri);
    const current = resolve();
    if (!current || current.projectPath !== target.projectPath || this.sessions.sessionFor({ uri }) !== session) { return; }
    await vscode.window.showTextDocument(document, { preview: true,
      selection: new vscode.Range(document.positionAt(current.declaration.range.start), document.positionAt(current.declaration.range.end)) });
  }

  private async openRelatedScript(node: SidebarNode): Promise<void> {
    if (node?.kind !== 'script') { return; }
    const session = this.sessions.sessionFor({ uri: node.root });
    if (!session || session.fileSystem.toUri(session.project.root).toString() !== node.root.toString()) { return; }
    const connected = async (): Promise<boolean> =>
      (await scriptsForOwner(this.sessions, session, node.parent)).some((entry) => entry.projectPath === node.projectPath);
    if (!await connected()) { return; }
    const uri = session.uriOf(node.projectPath);
    if (this.sessions.sessionFor({ uri }) !== session) { return; }
    const document = await vscode.workspace.openTextDocument(uri);
    if (await connected() && this.sessions.sessionFor({ uri }) === session) {
      await vscode.window.showTextDocument(document, { preview: true });
    }
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
    node.kind === 'renderedBy' ? [node.name, node.projectPath, node.offset] :
    node.kind === 'extendedBy' || node.kind === 'includedBy' ? [node.name] :
    node.kind === 'extending' ? [node.name, node.templateName] :
    node.kind === 'including' ? [node.name, node.projectPath, node.via] :
    node.kind === 'stimulusController' || node.kind === 'component' ? [node.name] :
    node.kind === 'stimulusUse' ? [node.name, node.projectPath] :
    node.kind === 'componentPart' ? [node.name, node.part] :
    node.kind === 'loaded' ? [nodeId(node.parent), 'loaded', node.projectPath] :
    node.kind === 'stimulusGroup' ? [nodeId(node.parent), 'stimulusGroup'] :
    node.kind === 'boundController' ? [nodeId(node.parent), 'boundController', node.name] :
    node.kind === 'wiring' ? [nodeId(node.parent), 'wiring', node.name, node.wiringKind, node.member,
      node.event ?? '', node.projectPath, node.offset] :
    node.kind === 'script' || node.kind === 'style' ? [nodeId(node.parent), node.kind, node.projectPath] :
    node.kind === 'controllerDependencies' || node.kind === 'controllerDependency' || node.kind === 'controllerScripts'
      ? [node.projectPath, node.className, node.kind === 'controllerDependency' ? node.typeName : '']
    : isControllerNode(node) ? [node.projectPath, node.className,
      node.kind === 'controller' ? '' : node.methodName, node.kind === 'controllerTemplate' ? node.name : '']
      : node.kind === 'section' ? node.section
      : node.kind === 'route' ? [node.section, node.name] : node.kind === 'routeConsumer' ? [node.section, node.name, node.projectPath, node.offset]
      : node.kind === 'routeTemplate' ? [node.section, node.name, node.templateName]
      : node.kind === 'warning' ? node.reason : node.kind === 'action' ? [node.reason, node.action]
      : node.kind === 'folder' ? [node.namespace, node.path]
      : node.kind === 'namespace' ? node.namespace : node.kind === 'template' ? node.name : '']);
}

function isControllerNode(node: SidebarNode): node is ControllerNode {
  return node?.kind === 'controller' || node?.kind === 'controllerMethod' || node?.kind === 'controllerTemplate';
}

function isScriptOwner(node: SidebarNode): node is ScriptOwner {
  return ['controllerScripts', 'controllerTemplate', 'template', 'routeTemplate'].includes(node.kind);
}

/** The entrypoints a template renders, as the head of its loading chain. */
/**
 * The template a row stands for, or nothing when the row has gone stale.
 *
 * A node keeps the name it was built with, and the tree is asked about it
 * again after the project moved underneath it: a controller whose render site
 * has gone, or a route whose action no longer renders the template named here.
 * Answering from the name alone would list the scripts and stylesheets of a
 * page nothing renders any more.
 */
function templatesForOwner(sessions: SessionManager, session: ProjectSession, node: ScriptOwner): readonly string[] {
  if (node.kind === 'controllerScripts') { return []; }
  if (node.kind === 'controllerTemplate') {
    return controllerSites(sessions, session, node).length ? [node.name] : [];
  }
  if (node.kind === 'routeTemplate') {
    const route = session.frontend.routes.find((entry) => entry.name === node.name);
    return route && routeAction(sessions, session, route)?.action.templates.includes(node.templateName)
      ? [node.templateName] : [];
  }
  return [node.name];
}

function entrypointsForOwner(sessions: SessionManager, session: ProjectSession, node: ScriptOwner): readonly ChainEntry[] {
  return templateEntrypoints(sessions, session, templatesForOwner(sessions, session, node));
}

/** Stylesheets for the same owners, from the same template walk as scripts. */
function stylesForOwner(sessions: SessionManager, session: ProjectSession, node: ScriptOwner): Promise<readonly RelatedStyle[]> {
  return templateStyles(sessions, session, templatesForOwner(sessions, session, node));
}

function scriptsForOwner(sessions: SessionManager, session: ProjectSession, node: ScriptOwner): Promise<readonly RelatedScript[]> {
  // The only owner that is not a template: its scripts come from the
  // controller's own registrations rather than from anything a page renders.
  return node.kind === 'controllerScripts'
    ? controllerScripts(sessions, session, node)
    : templateScripts(sessions, session, templatesForOwner(sessions, session, node));
}

function scriptIcon(path: string): SidebarRole { return path.endsWith('.ts') ? 'typescript' : 'javascript'; }

/** A Stimulus controller is a script, but a row under Stimulus keeps the
 * Stimulus hue: a section whose children change colour reads as a mistake. */
function stimulusScriptIcon(path: string): SidebarRole { return path.endsWith('.ts') ? 'stimulusTypescript' : 'stimulusJavascript'; }

/**
 * What points at this template, above what it loads.
 *
 * Both are the direction the file cannot state. A template names what it
 * extends on its first line, and that name already navigates, but nothing in
 * it names the controller that renders it or the pages built on it.
 *
 * Only for a template browsed on its own. A row reached from a controller or a
 * route arrived by one of these links already, and repeating it there would
 * lead back where the reader just came from.
 */
function incomingTemplateRows(sessions: SessionManager, session: ProjectSession, node: ScriptOwner): SidebarNode[] {
  if (node.kind !== 'template') { return []; }
  const name = node.name;
  const rows: SidebarNode[] = renderedBy(sessions, session, name).map((site) => ({
    kind: 'renderedBy' as const, root: node.root, name,
    projectPath: site.projectPath, label: site.label, offset: site.offset,
  }));
  if (extendingTemplates(sessions, session, name).length > 0) {
    rows.push({ kind: 'extendedBy', root: node.root, name });
  }
  if (includingTemplates(sessions, session, name).length > 0) {
    rows.push({ kind: 'includedBy', root: node.root, name });
  }
  return rows;
}

/**
 * The controller actions that render a template, as rows rather than a group.
 *
 * A render site is an actual render() call, so a partial that is only ever
 * included has none and a page has one or two. There is nothing here to fold
 * away behind an extra click.
 */
function renderedBy(sessions: SessionManager, session: ProjectSession, templateName: string):
readonly { projectPath: string; label: string; offset: number }[] {
  const template = session.lookup(templateName);
  if (template === undefined) { return []; }
  return session.renderSites.index.forTemplate(template.projectPath, session.index)
    .filter((site) => sessions.owns(session, site.projectPath))
    .map((site) => {
      const owner = site.className?.split('\\').at(-1) ?? site.projectPath;
      return { projectPath: site.projectPath, offset: site.nameRange.start,
        label: site.methodName === undefined ? owner : `${owner}::${site.methodName}()` };
    })
    .sort((left, right) => left.label.localeCompare(right.label) || left.offset - right.offset);
}

/** Templates extending this one, behind a group because a layout can have many. */
function extendingTemplates(sessions: SessionManager, session: ProjectSession, templateName: string): readonly string[] {
  const index = frontendIndex(sessions, session);
  return index.extendedBy(templateName)
    .flatMap((projectPath) => session.index.templatesForProjectPath(projectPath).map((entry) => entry.name))
    .filter((name, at, all) => all.indexOf(name) === at)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Templates that pull this one in without extending it.
 *
 * The answer a partial cannot give about itself. Kept as project paths rather
 * than template names: a partial is included by its file, and the reader is
 * about to open that file, so the path is the useful identity even where a
 * template happens to carry several names.
 */
function includingTemplates(sessions: SessionManager, session: ProjectSession, templateName: string): readonly IncomingReference[] {
  return frontendIndex(sessions, session).includedBy(templateName);
}

/** The exact attribute a wiring row stands for, or nothing once it has gone. */
function wiringFor(sessions: SessionManager, session: ProjectSession,
  node: Extract<SidebarNode, { kind: 'wiring' }>): BoundWiring | undefined {
  return boundControllerFor(sessions, session, node)?.wiring.find((entry) =>
    entry.kind === node.wiringKind && entry.name === node.member && entry.event === node.event &&
    entry.projectPath === node.projectPath && entry.offset === node.offset);
}

/** The file a script owner's own template lives in, so a row can say when a
 * binding came from somewhere else instead. */
function templateOwnerPath(session: ProjectSession, node: ScriptOwner): string | undefined {
  const name = node.kind === 'template' ? node.name : node.kind === 'routeTemplate' ? node.templateName
    : node.kind === 'controllerTemplate' ? node.name : undefined;
  return name === undefined ? undefined : session.lookup(name)?.projectPath;
}

/** The mounted controller a row stands for, or nothing once it has gone. */
function boundControllerFor(sessions: SessionManager, session: ProjectSession,
  node: Extract<SidebarNode, { kind: 'boundController' | 'wiring' }>): BoundController | undefined {
  return templateControllers(sessions, session, templatesForOwner(sessions, session, node.parent))
    .find((entry) => entry.name === node.name);
}

/** The components this project registered, by the name markup writes. */
function componentsInProject(session: ProjectSession): readonly TwigComponent[] {
  return session.components.components.slice().sort((left, right) => left.name.localeCompare(right.name));
}

/** A component's PHP class, when it has one and this session owns it. */
function componentClassPath(sessions: SessionManager, session: ProjectSession, component: TwigComponent): string | undefined {
  if (component.className === undefined) { return undefined; }
  // Two classes of the same name cannot be told apart from the registration.
  const declarations = frontendIndex(sessions, session).classPaths(component.className);
  return declarations.length === 1 ? declarations[0] : undefined;
}

/**
 * The controllers this session owns, decided once per change.
 *
 * Every row under the Controllers section resolves its controller through
 * here, and deciding ownership is a question per controller, so the answer for
 * a whole project was rebuilt once per row drawn.
 */
const owned = new WeakMap<ProjectSession,
  { version: number; layout: number; enabled: boolean; controllers: readonly RenderingController[] }>();

function controllersInProject(sessions: SessionManager, session: ProjectSession): readonly RenderingController[] {
  const version = session.renderSites.index.version;
  const enabled = isEnabled();
  const found = owned.get(session);
  if (found?.version === version && found.layout === sessions.layoutVersion && found.enabled === enabled) {
    return found.controllers;
  }
  const controllers = session.renderSites.index.controllers()
    .filter((controller) => sessions.owns(session, controller.projectPath));
  owned.set(session, { version, layout: sessions.layoutVersion, enabled, controllers });
  return controllers;
}

function controllerSites(sessions: SessionManager, session: ProjectSession, node: ControllerNode): readonly RenderSite[] {
  const controller = controllersInProject(sessions, session).find((entry) =>
    entry.projectPath === node.projectPath && entry.className === node.className);
  return controller?.sites.filter((site) => node.kind === 'controller' ||
    (site.methodName === node.methodName && (node.kind !== 'controllerTemplate' || site.templateName === node.name))) ?? [];
}

function controllerRoutes(sessions: SessionManager, session: ProjectSession,
  node: ControllerIdentity & { readonly methodName: string }): readonly SymfonyRoute[] {
  return session.frontend.routes.filter((route) => {
    const target = routeAction(sessions, session, route);
    return target?.projectPath === node.projectPath && target.action.className === node.className &&
      target.action.methodName === node.methodName;
  }).sort(compareRoutePaths);
}

/**
 * Every action that deserves a row under a controller.
 *
 * Render sites alone are not enough: an action returning JSON names no
 * template, so it produces no site and would be missing from the tree entirely
 * even though its route is listed under API routes. An endpoint is an action
 * whether or not it renders anything.
 */
function controllerActionMethods(sessions: SessionManager, session: ProjectSession,
  node: ControllerNode): readonly string[] {
  const rendering = controllerSites(sessions, session, node).map((site) => site.methodName!);
  const routed = session.frontend.routes.flatMap((route) => {
    const target = routeAction(sessions, session, route);
    return target?.projectPath === node.projectPath && target.action.className === node.className
      ? [target.action.methodName] : [];
  });
  return [...new Set([...rendering, ...routed])];
}

/**
 * The icon for a route, decided by what the route actually does.
 *
 * Shared by the route sections and the rows under a controller, because the
 * same route appearing in both places must not be drawn two different ways.
 * The leaf icon claims a template is rendered, so it must never land on an
 * endpoint that renders nothing.
 */
function routeIcon(sessions: SessionManager, session: ProjectSession, route: SymfonyRoute): SidebarRole {
  const action = routeAction(sessions, session, route)?.action;
  if (route.format === 'json' || action?.json) { return 'jsonRoute'; }
  return action?.templates.length ? 'templateRoute' : 'route';
}

/** One icon for an action that may carry several routes, by strongest claim. */
function actionRouteIcon(routes: readonly SidebarRole[]): SidebarRole {
  if (!routes.length) { return 'method'; }
  if (routes.includes('jsonRoute')) { return 'jsonRoute'; }
  return routes.includes('templateRoute') ? 'templateRoute' : 'route';
}

function warningReasons(session: ProjectSession): WarningReason[] {
  const reasons: WarningReason[] = [];
  if (session.loaderPaths.source === 'config') {
    reasons.push('namespaces');
  }
  // Routes, Stimulus controllers and components all come from the console.
  // Without it every one of those sections is simply absent, which reads as a
  // project that has none rather than as an answer nothing could give.
  if (consoleWarning(session) !== undefined) {
    reasons.push('console');
  }
  if (session.index.truncated) {
    reasons.push('indexLimit');
  }
  return reasons;
}

/**
 * What the console could not answer, or nothing when it answered everything.
 *
 * Only where the project says it should have answered: a project with no
 * StimulusBundle installed is not missing Stimulus controllers, so reporting
 * their absence would be noise on the projects that never wanted them.
 */
function consoleWarning(session: ProjectSession): string | undefined {
  // Nothing to report where there is no console to run: switching it off, or
  // an untrusted workspace, is already explained by the namespaces warning.
  if (session.consoleCommand === undefined) { return undefined; }
  const missing = [
    session.frontend.routesStatus.startsWith('unavailable') ? `Routes: ${session.frontend.routesStatus}` : undefined,
    session.frontend.stimulusStatus.startsWith('unavailable') ? `Stimulus: ${session.frontend.stimulusStatus}` : undefined,
    session.components.status.startsWith('unavailable') ? `Components: ${session.components.status}` : undefined,
  ].filter((entry): entry is string => entry !== undefined);
  return missing.length === 0 ? undefined : missing.join('\n');
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

/** A row that opens a file: the editor's own open command, and the URI as the
 * row's resource so decorations and drag work as they do in Explorer. */
function opens(item: vscode.TreeItem, uri: vscode.Uri, title: string): vscode.TreeItem {
  item.resourceUri = uri;
  item.command = { command: 'vscode.open', title, arguments: [uri] };
  return item;
}

function namespaceKey(namespace: string | null, forcesBundleTemplate: boolean): string {
  return namespace === null ? '' : `@${forcesBundleTemplate ? '!' : ''}${namespace}`;
}

/**
 * Every name under the key the tree draws it beneath, grouped once per index.
 *
 * Deciding the key means parsing the name, and the tree needed it for the
 * label and the children of every namespace and every folder row, so a project
 * with three thousand templates parsed every one of them around eighty times
 * to draw the tree once. An index never changes after it is built, so holding
 * the grouping by identity is enough to keep it current.
 */
const namespaceGroups = new WeakMap<TwigTemplateIndex, ReadonlyMap<string, readonly string[]>>();

function groupsOf(index: TwigTemplateIndex): ReadonlyMap<string, readonly string[]> {
  let found = namespaceGroups.get(index);
  if (found === undefined) {
    const built = new Map<string, string[]>();
    // allNames is sorted, so each group comes out sorted with it.
    for (const name of index.allNames()) {
      const key = namespaceOf(name);
      const into = built.get(key);
      if (into === undefined) { built.set(key, [name]); } else { into.push(name); }
    }
    found = built;
    namespaceGroups.set(index, found);
  }
  return found;
}

/** The loader directories behind a namespace row, as the tree keys namespaces. */
function loaderDirectories(session: ProjectSession, namespace: string): readonly string[] {
  return session.loaderPaths.paths.all().find((entry) =>
    namespaceKey(entry.namespace, entry.forcesBundleTemplate) === namespace)?.directories ?? [];
}

function namesInGroup(session: ProjectSession, namespace: string): readonly string[] {
  return groupsOf(session.index).get(namespace) ?? [];
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
