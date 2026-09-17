import * as vscode from 'vscode';

import { parseTemplateName, type IncomingReference, type OffsetRange, type TwigTemplateIndex, type LoaderPathEntry, type LoaderPathSource, type RenderingController, type RenderSite, type SymfonyRoute, type TwigComponent, type TwigReferenceKind } from '@wicker/core';

import { basename, dirname, enginePathOf } from './paths.js';
import { rangeOf } from './ranges.js';
import { isEnabled, type ProjectSession, type SessionManager } from './session.js';
import { counted } from './text.js';
import { apiRoutes, compareRoutePaths, controllerDependencies, frontendIndex, routeAction, routeConsumers, routeRequesters, stimulusControllers, templateRoutes, templatesBinding } from './frontendProject.js';
import { dependencyKind, sidebarIcon, type SidebarRole } from './sidebarIcons.js';
import { commandLabel, seconds, slowestAnswer } from './consoleTimings.js';
import { commonPrefix, leafName, parentPath, pathLevel, pathSegments } from './pathTree.js';
import { controllerScripts, templateControllers, templateScripts, type BoundController, type BoundWiring, type RelatedScript } from './relatedScripts.js';
import { templateStyles, type RelatedStyle } from './relatedStyles.js';
import { chainChildren, templateEntrypoints, type ChainEntry } from './loadingChain.js';

const SHOW_BUNDLES_KEY = 'wicker.sidebar.showBundleTemplates';
type WarningReason = 'namespaces' | 'indexLimit' | 'console';
type SectionName = 'controllers' | 'templates' | 'api' | 'templateRoutes' | 'components' | 'stimulus';
/** Where a row leads: a file, and the text in it to select when there is one. */
type Target = { readonly projectPath: string; readonly range?: OffsetRange };
/** How a row opens its file: in the active editor group, or beside it. */
type OpenOptions = { readonly beside?: boolean };
/** The row commands that open a file, which a menu can offer to open beside. */
const OPENERS = new Set(['vscode.open', 'wicker.openTemplate', 'wicker.openController', 'wicker.openControllerDependency',
  'wicker.openRelatedScript', 'wicker.openEndpoint', 'wicker.openRenderedBy', 'wicker.openWiring']);
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
  | { readonly kind: 'routeFolder'; readonly root: vscode.Uri; readonly section: 'api' | 'templateRoutes'; readonly path: string }
  | { readonly kind: 'controllerFolder'; readonly root: vscode.Uri; readonly path: string }
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
  | { readonly kind: 'pending'; readonly root: vscode.Uri }
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
        if (event.affectsConfiguration('wicker.enable') || event.affectsConfiguration('wicker.sidebar.colors') ||
          event.affectsConfiguration('wicker.sidebar.routeHierarchy') ||
          event.affectsConfiguration('wicker.sidebar.controllerNamespaces')) {
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
        ...(session.consolePending ? [{ kind: 'pending' as const, root: node.root }] : []),
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
      const routes = this.routesIn(session, section);
      if (routeHierarchyOn()) { return routeLevelNodes(node.root, routes, '', section); }
      return routes.map((route) => ({ kind: 'route', root: node.root, name: route.name, section }));
    }
    if (node.kind === 'routeFolder') {
      return routeLevelNodes(node.root, this.routesIn(session, node.section), node.path, node.section);
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
        // Under a controller, the template is the action's row, so the route
        // the action answers belongs directly beneath it.
        ...(node.kind === 'controllerTemplate' ? [{ root: node.root, projectPath: node.projectPath,
          className: node.className, kind: 'controllerMethod' as const, methodName: node.methodName }] : []),
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
      return controllerLevel(this.sessions, session, node.root, '');
    }
    if (node.kind === 'controllerFolder') {
      return controllerLevel(this.sessions, session, node.root, node.path);
    }
    if (node.kind === 'controller') {
      const actions = controllerActionMethods(this.sessions, session, node).map((methodName) => {
        const method = { ...node, kind: 'controllerMethod' as const, methodName };
        const sites = controllerSites(this.sessions, session, method);
        const routes = controllerRoutes(this.sessions, session, method);
        return { method, route: routes[0], templates: [...new Set(sites.map((site) => site.templateName))],
          rank: ACTION_ORDER[actionIcon(this.sessions, session, method, sites, routes)] };
      });
      // What the controller renders first, then what it answers, then the
      // rest: a page and an endpoint are different kinds of thing, and a
      // list that interleaves them has to be read row by row.
      actions.sort((left, right) => left.rank - right.rank ||
        (left.route && right.route ? compareRoutePaths(left.route, right.route) : left.route ? -1 : right.route ? 1 : 0) ||
        left.method.methodName.localeCompare(right.method.methodName));
      return [
        // An action is read by what it produces. One that renders is its
        // template, with the route it answers beneath; one that does not is
        // the method itself, which for a JSON endpoint is its route.
        ...actions.flatMap<SidebarNode>(({ method, templates }) => templates.length === 0 ? [method]
          : templates.map((name) => ({ ...node, kind: 'controllerTemplate' as const, methodName: method.methodName, name }))),
        ...(controllerDependencies(this.sessions, session, node).length
          ? [{ ...node, kind: 'controllerDependencies' as const }] : []),
        ...((await controllerScripts(this.sessions, session, node)).length
          ? [{ ...node, kind: 'controllerScripts' as const }] : []),
      ];
    }
    if (node.kind === 'controllerMethod') { return []; }
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
    if (node.kind === 'route' || node.kind === 'routeFolder') {
      // A route is a leaf of the folder its path ends in, and a folder of the
      // one above it; both reach the section where the path runs out.
      const path = node.kind === 'routeFolder' ? node.path : routeHierarchyOn()
        ? this.sessionForRoot(node.root)?.frontend.routes.find((route) => route.name === node.name)?.path : undefined;
      const folder = path === undefined ? '' : parentPath(path);
      return folder === '' ? { kind: 'section', root: node.root, section: node.section }
        : { kind: 'routeFolder', root: node.root, section: node.section, path: folder };
    }
    if (node.kind === 'routeConsumer' || node.kind === 'routeTemplate') { return { kind: 'route', root: node.root, name: node.name, section: node.section }; }
    if (node.kind === 'project') {
      return undefined;
    }
    if (node.kind === 'action') {
      return { kind: 'warning', root: node.root, reason: node.reason };
    }
    if (node.kind === 'namespace') {
      return { kind: 'section', root: node.root, section: 'templates' };
    }
    if (node.kind === 'controllerDependency') {
      return { kind: 'controllerDependencies', root: node.root, projectPath: node.projectPath, className: node.className };
    }
    if (node.kind === 'controllerTemplate' || node.kind === 'controllerDependencies' || node.kind === 'controllerScripts') {
      return { kind: 'controller', root: node.root, projectPath: node.projectPath, className: node.className };
    }
    if (node.kind === 'controllerFolder') {
      const above = parentPath(node.path);
      return above === '' ? { kind: 'section', root: node.root, section: 'controllers' }
        : { kind: 'controllerFolder', root: node.root, path: above };
    }
    if (node.kind === 'controller') {
      const session = this.sessionForRoot(node.root);
      const folder = session === undefined ? '' : parentPath(controllerPaths(this.sessions, session)
        .find((entry) => entry.projectPath === node.projectPath && entry.className === node.className)?.path ?? '');
      return folder === '' ? { kind: 'section', root: node.root, section: 'controllers' }
        : { kind: 'controllerFolder', root: node.root, path: folder };
    }
    if (node.kind === 'controllerMethod') {
      // An action that renders sits under the template it renders, and under
      // the first of them when it renders several.
      const session = this.sessionForRoot(node.root);
      const [name] = session === undefined ? []
        : [...new Set(controllerSites(this.sessions, session, node).map((site) => site.templateName))];
      return name === undefined
        ? { kind: 'controller', root: node.root, projectPath: node.projectPath, className: node.className }
        : { kind: 'controllerTemplate', root: node.root, projectPath: node.projectPath, className: node.className,
          methodName: node.methodName, name };
    }
    if (node.kind === 'template' || node.kind === 'folder') {
      const namespace = node.kind === 'template' ? namespaceOf(node.name) : node.namespace;
      const folder = dirname(node.kind === 'template' ? templatePath(node.name) : node.path);
      return folder === ''
        ? { kind: 'namespace', root: node.root, namespace }
        : { kind: 'folder', root: node.root, namespace, path: folder };
    }
    return { kind: 'project', root: node.root };
  }

  /** The routes a section lists, so its folders count and hold the same set its rows come from. */
  private routesIn(session: ProjectSession, section: 'api' | 'templateRoutes'): readonly SymfonyRoute[] {
    return section === 'api' ? apiRoutes(this.sessions, session) : templateRoutes(this.sessions, session);
  }

  private sessionForRoot(root: vscode.Uri): ProjectSession | undefined {
    return this.sessions.sessionAtRoot(root);
  }

  async getTreeItem(node: SidebarNode): Promise<vscode.TreeItem> {
    const session = this.sessionForRoot(node.root);
    if (session === undefined) {
      return new vscode.TreeItem('Project unavailable');
    }
    const item = await this.describe(node, session);
    item.id = nodeId(node);
    // Words a menu's when-clause can test: the kind, any word describe()
    // added, whether the row opens a file and whether it has one to reveal.
    item.contextValue = [`wicker.${node.kind}`, ...(item.contextValue === undefined ? [] : [item.contextValue]),
      ...(item.command !== undefined && OPENERS.has(item.command.command) ? ['opens'] : []),
      ...(item.resourceUri === undefined ? [] : ['file']),
    ].join(' ');
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
      item.description = dirname(node.projectPath);
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
      // The parent lists this group only when there is something in it, so
      // there is no need to compute the scripts again to know it expands.
      const item = new vscode.TreeItem('Scripts', vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = sidebarIcon('scripts');
      item.tooltip = 'Scripts associated through rendered templates, Stimulus bindings or route consumers.';
      return item;
    }
    if (node.kind === 'renderedBy') {
      const item = new vscode.TreeItem(node.label);
      item.description = 'Renders this';
      // The row names the controller, so it wears the controller's icon, the
      // same PHP class glyph as under Controllers. Its routes go in the tooltip.
      const site = renderedBy(this.sessions, session, node.name)
        .find((entry) => entry.projectPath === node.projectPath && entry.offset === node.offset);
      const routes = site?.className !== undefined && site.methodName !== undefined
        ? controllerRoutes(this.sessions, session, { root: node.root, projectPath: node.projectPath,
          className: site.className, methodName: site.methodName }) : [];
      item.iconPath = sidebarIcon('controller');
      item.tooltip = `${node.projectPath}${routes.length ? `\n\nRoutes:\n${
        routes.map((route) => `${route.methods} ${route.path} (${route.name})`).join('\n')}` : ''}

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
      item.description = dirname(templatePath(node.templateName));
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
      item.description = dirname(node.projectPath);
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
      item.description = dirname(node.projectPath);
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
    if (node.kind === 'controllerFolder') {
      const segments = pathSegments(node.path);
      const count = controllerPaths(this.sessions, session)
        .filter((entry) => entry.path.startsWith(`${node.path}/`)).length;
      const item = new vscode.TreeItem(segments.at(-1) ?? node.path, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = sidebarIcon('controllerFolder');
      item.description = String(count);
      item.tooltip = `${namespaceOfPath(this.sessions, session, node.path)}\n${counted(count, 'controller')} in this namespace.`;
      return item;
    }
    if (node.kind === 'routeFolder') {
      const folder = pathSegments(node.path);
      const count = this.routesIn(session, node.section).filter((route) => {
        const segments = pathSegments(route.path);
        return segments.length > folder.length && folder.every((segment, at) => segments[at] === segment);
      }).length;
      const item = new vscode.TreeItem(folder.at(-1) ?? node.path, vscode.TreeItemCollapsibleState.Collapsed);
      // A folder wears its section's hue: a branch whose rows change colour
      // halfway down reads as a mistake.
      item.iconPath = sidebarIcon(node.section === 'api' ? 'routeFolder' : 'templateRouteFolder');
      item.description = String(count);
      item.tooltip = `/${node.path}\n${counted(count, 'endpoint')} beneath this path.`;
      return item;
    }
    if (node.kind === 'route' || node.kind === 'routeConsumer' || node.kind === 'routeTemplate') {
      const route = session.frontend.routes.find((route) => route.name === node.name);
      const rowIcon = route ? routeIcon(this.sessions, session, route) : 'route';
      // Inside the hierarchy the folders above already spell the path, so the
      // row is named by where it ends; the tooltip still gives the whole of it.
      const nested = node.kind === 'route' && route !== undefined && routeHierarchyOn();
      const label = node.kind === 'route' ? `${route?.methods ?? ''} ${route === undefined ? node.name : nested ? leafName(route.path) : route.path}` :
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
      item.tooltip = node.kind === 'route' ? `${nested && route ? `${route.methods} ${route.path}\n` : ''}${route?.controller ?? node.name}\n${fetchers.length === 0 ? '' :
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
        // A controller holds its actions whether or not any renders; an
        // action holds only what it renders.
        (await this.getChildren(node)).length === 0
          ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
      // An action wears what it produces: the object for JSON, the leaf for
      // Twig, and the plain method icon for one that does neither. Read from
      // the action itself rather than from its route, so a row does not
      // change icon when the console finally answers.
      item.iconPath = sidebarIcon(template ? 'template' : controller ? 'controller'
        : actionIcon(this.sessions, session, node, sites, routes));
      item.tooltip = `${node.className}${controller ? '' : `::${node.methodName}()`}\n${node.projectPath}`;
      if (!template) {
        // The number of actions listed beneath it, rendering or not. An
        // action names its method; what it renders is the row above it.
        item.description = controller ? String(controllerActionMethods(this.sessions, session, node).length)
          : routes.length ? `${node.methodName}()` : '';
        if (routes.length) {
          item.tooltip += `\n\nRoutes:\n${routes.map((route) => `${route.methods} ${route.path} (${route.name})`).join('\n')}`;
          // A word for the menu: the row has a route to copy.
          item.contextValue = 'routed';
        }
        if (!controller && templateNames.length) { item.tooltip += `\n\nRenders:\n${templateNames.join('\n')}`; }
        item.tooltip += controller ? '\nOpen controller file.'
          : sites.length ? '\nOpen the first render call or #[Template] attribute.' : '\nOpen the action.';
        item.resourceUri = session.uriOf(node.projectPath);
      } else {
        const resolved = session.lookup(node.name);
        // Which of the controller's actions renders it, since the row is now
        // the action's own place in the tree.
        item.description = `${node.methodName}()`;
        item.tooltip = `${node.name}\n${resolved?.projectPath ?? 'This template name could not be resolved with the current index.'}`;
        if (resolved === undefined) {
          item.description = 'Unresolved';
          item.iconPath = sidebarIcon('warning');
        } else {
          item.resourceUri = session.uriFor(resolved);
        }
      }
      // A controller opens its file and an action opens where it is declared,
      // whether or not either renders anything. A row drawn for a controller
      // that an edit has since removed opens nothing.
      const opens = template ? sites.length > 0 && session.lookup(node.name) !== undefined
        : controller ? controllersInProject(this.sessions, session).some((entry) =>
          entry.projectPath === node.projectPath && entry.className === node.className)
          : sites.length > 0 || routes.length > 0;
      if (opens) {
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
      const slowest = slowestAnswer(session.consoleTimings);
      if (slowest !== undefined) {
        item.tooltip += `\nSlowest console answer: ${commandLabel(slowest.command)}, ${seconds(slowest.ms)}`;
      }
      if (!this.showBundles) {
        item.tooltip += `\n${counted(visibleFiles, 'file')} shown. Bundle namespaces are hidden; use Show bundle templates to browse them.`;
      }
      if (session.index.truncated) {
        item.tooltip += '\nIndex limit reached. Increase wicker.index.maxFiles to include more templates.';
      }
      return item;
    }
    if (node.kind === 'pending') {
      const item = new vscode.TreeItem('Asking the Symfony console...');
      item.iconPath = sidebarIcon('pending');
      item.tooltip = 'Bundle namespaces, routes, Stimulus controllers and components are read from Symfony, and its console has not answered yet. ' +
        `The tree shows what the files and the last answer say meanwhile, and fills in when it does.\n\nWicker runs ${
          session.consoleCommand ?? 'php bin/console'} in the project root.`;
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
      item.description = dirname(node.projectPath);
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
      // Detection is over once a project is in the tree, which is before its
      // console has answered; the message would otherwise sit over a drawn
      // tree for as long as that takes.
      sessions.onDidChange(() => {
        if (this.view.message !== '' && sessions.all().length > 0) { this.view.message = ''; }
      }),
      vscode.commands.registerCommand('wicker.openController', (node: SidebarNode, options?: OpenOptions) => this.openController(node, options)),
      vscode.commands.registerCommand('wicker.openControllerDependency', (node: SidebarNode, options?: OpenOptions) => this.openControllerDependency(node, options)),
      vscode.commands.registerCommand('wicker.openRelatedScript', (node: SidebarNode, options?: OpenOptions) => this.openRelatedScript(node, options)),
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
      vscode.commands.registerCommand('wicker.openTemplate', (root: vscode.Uri, name: string, options?: OpenOptions) =>
        this.reveal(root, (session) => {
          const template = session.lookup(name);
          return template === undefined ? undefined : { projectPath: template.projectPath };
        }, options)),
      vscode.commands.registerCommand('wicker.revealTemplate', () => this.revealActiveTemplate()),
      vscode.commands.registerCommand('wicker.openEndpoint', (node: SidebarNode, options?: OpenOptions) => this.openEndpoint(node, options)),
      vscode.commands.registerCommand('wicker.openRenderedBy', (node: SidebarNode, options?: OpenOptions) => this.openRenderedBy(node, options)),
      vscode.commands.registerCommand('wicker.openWiring', (node: SidebarNode, options?: OpenOptions) => this.openWiring(node, options)),
      vscode.commands.registerCommand('wicker.openToSide', (node: SidebarNode) => this.openToSide(node)),
      vscode.commands.registerCommand('wicker.revealInExplorer', (node: SidebarNode) => this.revealInExplorer(node)),
      vscode.commands.registerCommand('wicker.copyTemplateName', (node: SidebarNode) => this.copyTemplateName(node)),
      vscode.commands.registerCommand('wicker.copyRouteName', (node: SidebarNode) => this.copyRoute(node, 'name')),
      vscode.commands.registerCommand('wicker.copyRoutePath', (node: SidebarNode) => this.copyRoute(node, 'path')),
      vscode.commands.registerCommand('wicker.copyControllerName', (node: SidebarNode) => this.copyControllerName(node)),
      vscode.commands.registerCommand('wicker.showBundleTemplates', () => this.setShowBundleTemplates(true)),
      vscode.commands.registerCommand('wicker.hideBundleTemplates', () => this.setShowBundleTemplates(false)),
      vscode.window.onDidChangeActiveTextEditor(() => {
        const node = this.activeTemplateNode();
        this.updateRevealContext(node);
        void this.followActiveEditor(node);
      }),
      this.view.onDidChangeVisibility((event) => { if (event.visible) { void this.followActiveEditor(); } }),
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
   * Opens what a row leads to, the way every row does.
   *
   * The row holds identifiers, and the target is resolved from the live index
   * twice: once to know where to go, and once more after the document opens,
   * because opening can reindex. A row built from something that has moved or
   * gone since goes nowhere, rather than selecting unrelated text at an offset
   * that used to mean something.
   */
  private async reveal(root: vscode.Uri,
    target: (session: ProjectSession) => Promise<Target | undefined> | Target | undefined,
    options?: OpenOptions): Promise<void> {
    const session = this.sessions.sessionAtRoot(root);
    if (session === undefined) { return; }
    const found = await target(session);
    if (found === undefined || !this.sessions.owns(session, found.projectPath)) { return; }
    const document = await vscode.workspace.openTextDocument(session.uriOf(found.projectPath));
    // Opening a file can reindex. Resolved again, so a row built before an
    // edit above its target goes nowhere rather than to the old offset, and a
    // target that has moved to another file or gone is not opened at all.
    const current = await target(session);
    if (current === undefined || current.projectPath !== found.projectPath ||
      this.sessions.sessionAtRoot(root) !== session) { return; }
    const range = current.range;
    await vscode.window.showTextDocument(document, { preview: true,
      ...(options?.beside ? { viewColumn: vscode.ViewColumn.Beside } : {}),
      ...(range === undefined ? {} : { selection: rangeOf(document, range) }) });
  }

  private openRenderedBy(node: SidebarNode, options?: OpenOptions): Promise<void> {
    if (node?.kind !== 'renderedBy') { return Promise.resolve(); }
    return this.reveal(node.root, (session) => {
      const site = renderedBy(this.sessions, session, node.name)
        .find((entry) => entry.projectPath === node.projectPath && entry.offset === node.offset);
      return site && { projectPath: site.projectPath, range: { start: site.offset, end: site.offset } };
    }, options);
  }

  private openWiring(node: SidebarNode, options?: OpenOptions): Promise<void> {
    if (node?.kind !== 'wiring') { return Promise.resolve(); }
    return this.reveal(node.root, (session) => {
      const wire = wiringFor(this.sessions, session, node);
      return wire && { projectPath: wire.projectPath, range: { start: wire.offset, end: wire.offset } };
    }, options);
  }

  private openEndpoint(node: SidebarNode, options?: OpenOptions): Promise<void> {
    if (node?.kind !== 'route' && node?.kind !== 'routeConsumer' && node?.kind !== 'routeTemplate') { return Promise.resolve(); }
    return this.reveal(node.root, (session) => {
      const route = session.frontend.routes.find((entry) => entry.name === node.name);
      if (route === undefined) { return undefined; }
      if (node.kind === 'route') {
        const action = routeAction(this.sessions, session, route);
        return action && { projectPath: action.projectPath, range: action.action.range };
      }
      if (node.kind === 'routeConsumer') {
        return routeConsumers(this.sessions, session, route)
          .find((use) => use.projectPath === node.projectPath && use.range.start === node.offset);
      }
      const template = session.lookup(node.templateName);
      return template && { projectPath: template.projectPath };
    }, options);
  }

  private openController(node: SidebarNode, options?: OpenOptions): Promise<void> {
    if (!isControllerNode(node)) { return Promise.resolve(); }
    return this.reveal(node.root, (session) => {
      const site = controllerSites(this.sessions, session, node)[0];
      if (node.kind === 'controllerTemplate') {
        const template = site === undefined ? undefined : session.lookup(node.name);
        return template && { projectPath: template.projectPath };
      }
      if (node.kind === 'controller') {
        return controllersInProject(this.sessions, session).some((entry) =>
          entry.projectPath === node.projectPath && entry.className === node.className) ? { projectPath: node.projectPath } : undefined;
      }
      if (site !== undefined) { return { projectPath: node.projectPath, range: site.nameRange }; }
      // An action that renders nothing is opened where it is declared.
      const [route] = controllerRoutes(this.sessions, session, node);
      const action = route === undefined ? undefined : routeAction(this.sessions, session, route);
      return action && { projectPath: action.projectPath, range: action.action.range };
    }, options);
  }

  private openControllerDependency(node: SidebarNode, options?: OpenOptions): Promise<void> {
    if (node?.kind !== 'controllerDependency') { return Promise.resolve(); }
    return this.reveal(node.root, (session) => {
      const dependency = controllerDependencies(this.sessions, session, node)
        .find((entry) => entry.declaration.name === node.typeName);
      return dependency && { projectPath: dependency.projectPath, range: dependency.declaration.range };
    }, options);
  }

  private openRelatedScript(node: SidebarNode, options?: OpenOptions): Promise<void> {
    if (node?.kind !== 'script') { return Promise.resolve(); }
    return this.reveal(node.root, async (session) =>
      (await scriptsForOwner(this.sessions, session, node.parent)).some((entry) => entry.projectPath === node.projectPath)
        ? { projectPath: node.projectPath } : undefined, options);
  }

  /** The row's own open, in the editor group beside the active one. */
  private async openToSide(node: SidebarNode): Promise<void> {
    const command = (await this.provider.getTreeItem(node)).command;
    if (command === undefined || !OPENERS.has(command.command)) { return; }
    const beside: OpenOptions = { beside: true };
    const args: readonly unknown[] = command.arguments ?? [];
    await vscode.commands.executeCommand(command.command, ...args,
      command.command === 'vscode.open' ? vscode.ViewColumn.Beside : beside);
  }

  private async revealInExplorer(node: SidebarNode): Promise<void> {
    const uri = (await this.provider.getTreeItem(node)).resourceUri;
    if (uri !== undefined) { await vscode.commands.executeCommand('revealInExplorer', uri); }
  }

  /** The logical name, as render() or an include tag writes it. */
  private async copyTemplateName(node: SidebarNode): Promise<void> {
    const name = node?.kind === 'template' || node?.kind === 'controllerTemplate' ? node.name
      : node?.kind === 'routeTemplate' || node?.kind === 'extending' ? node.templateName : undefined;
    if (name !== undefined) { await copied(name); }
  }

  /** The identifier, as data-controller writes it. */
  private async copyControllerName(node: SidebarNode): Promise<void> {
    if (node?.kind === 'stimulusController' || node?.kind === 'boundController') { await copied(node.name); }
  }

  /** The route a row stands for; an action carrying several routes asks which. */
  private async copyRoute(node: SidebarNode, part: 'name' | 'path'): Promise<void> {
    if (node?.root === undefined) { return; }
    const session = this.sessions.sessionAtRoot(node.root);
    if (session === undefined) { return; }
    const routes = node.kind === 'route' ? session.frontend.routes.filter((route) => route.name === node.name)
      : node.kind === 'controllerMethod' ? controllerRoutes(this.sessions, session, node) : [];
    const route = routes.length > 1
      ? (await vscode.window.showQuickPick(
        routes.map((entry) => ({ label: entry.name, description: `${entry.methods} ${entry.path}`, entry })),
        { placeHolder: `Which route's ${part}?` }))?.entry
      : routes[0];
    if (route !== undefined) { await copied(route[part]); }
  }

  private sessionForAction(node: SidebarNode): ProjectSession | undefined {
    if (node?.kind !== 'action') {
      return undefined;
    }
    const session = this.sessions.sessionAtRoot(node.root);
    return session !== undefined && warningReasons(session).includes(node.reason) ? session : undefined;
  }

  private async setShowBundleTemplates(show: boolean): Promise<void> {
    this.provider.setShowBundleTemplates(show);
    await vscode.commands.executeCommand('setContext', 'wicker.showBundleTemplates', show);
    await this.workspaceState.update(SHOW_BUNDLES_KEY, show);
  }

  /** The rows selected in the view. */
  get selection(): readonly SidebarNode[] { return this.view.selection; }

  /**
   * Selects the active editor's template, as the Explorer follows its file.
   *
   * Only while the view is showing, so a hidden sidebar costs nothing, and
   * without taking focus, so typing carries on. A bundle template stays
   * hidden: opening a vendor file is not a request to browse the bundle, and
   * the reveal button is there for that.
   */
  private async followActiveEditor(node = this.activeTemplateNode()): Promise<void> {
    if (!this.view.visible || !vscode.workspace.getConfiguration('wicker').get<boolean>('sidebar.autoReveal', true)) { return; }
    if (node?.kind !== 'template' || !this.provider.isTemplateVisible(node.root, node.name)) { return; }
    try {
      await this.view.reveal(node, { select: true, focus: false, expand: false });
    } catch { /* The tree changed under the reveal; the next editor change tries again. */ }
  }

  private updateRevealContext(node = this.activeTemplateNode()): void {
    // A view's resource context can describe a tree row instead of the editor.
    void vscode.commands.executeCommand('setContext', 'wicker.canRevealTemplate', node !== undefined);
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
      : node.kind === 'routeFolder' ? [node.section, node.path]
      : node.kind === 'controllerFolder' ? node.path
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
readonly { projectPath: string; label: string; offset: number; className?: string; methodName?: string }[] {
  const template = session.lookup(templateName);
  if (template === undefined) { return []; }
  return session.renderSites.index.forTemplate(template.projectPath, session.index)
    .filter((site) => sessions.owns(session, site.projectPath))
    .map((site) => {
      const owner = site.className?.split('\\').at(-1) ?? site.projectPath;
      return { projectPath: site.projectPath, offset: site.nameRange.start,
        label: site.methodName === undefined ? owner : `${owner}::${site.methodName}()`,
        ...(site.className === undefined ? {} : { className: site.className }),
        ...(site.methodName === undefined ? {} : { methodName: site.methodName }) };
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
const owned = new WeakMap<ProjectSession, { version: number; sources: number; routes: readonly SymfonyRoute[];
  layout: number; enabled: boolean; controllers: readonly RenderingController[] }>();

/**
 * The project's controllers: those that render a template, and those a route
 * names.
 *
 * A controller answering only JSON renders nothing, so it has no render site
 * to be found by. It had no row at all, while a JSON method did appear under
 * any controller that also rendered a page. A route names its controller
 * outright, which is evidence enough for a row.
 *
 * Kept on everything it is read from: the render sites, the PHP the actions
 * are found in, and the route list itself, which a console pass replaces.
 */
function controllersInProject(sessions: SessionManager, session: ProjectSession): readonly RenderingController[] {
  const version = session.renderSites.index.version;
  const sources = session.frontendSources.index.version;
  const routes = session.frontend.routes;
  const enabled = isEnabled();
  const found = owned.get(session);
  if (found?.version === version && found.sources === sources && found.routes === routes &&
    found.layout === sessions.layoutVersion && found.enabled === enabled) {
    return found.controllers;
  }
  const byClass = new Map(session.renderSites.index.controllers()
    .filter((controller) => sessions.owns(session, controller.projectPath))
    .map((controller) => [`${controller.projectPath}\n${controller.className}`, controller]));
  for (const route of routes) {
    const target = routeAction(sessions, session, route);
    const key = target === undefined ? undefined : `${target.projectPath}\n${target.action.className}`;
    if (target !== undefined && key !== undefined && !byClass.has(key)) {
      byClass.set(key, { projectPath: target.projectPath, className: target.action.className, sites: [] });
    }
  }
  const controllers = [...byClass.values()]
    .sort((left, right) => left.className.localeCompare(right.className) || left.projectPath.localeCompare(right.projectPath));
  owned.set(session, { version, sources, routes, layout: sessions.layoutVersion, enabled, controllers });
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
 * The icon for a controller's action: what it produces, not what reaches it.
 *
 * A route says the same thing, but only once the console has answered, and a
 * row that starts as a plain method and turns into a leaf a few seconds later
 * reads as the tree correcting itself. The PHP is there from the start, so
 * the render call and the JSON response decide, and the route is consulted
 * only for a format the PHP does not state.
 */
/** What an action can be, which is both its icon and its place in the list. */
type ActionRole = Extract<SidebarRole, 'templateRoute' | 'jsonRoute' | 'method'>;

/** Templates first, then JSON endpoints, then everything else, matching the icons. */
const ACTION_ORDER: Record<ActionRole, number> = { templateRoute: 0, jsonRoute: 1, method: 2 };

function actionIcon(sessions: SessionManager, session: ProjectSession,
  node: ControllerIdentity & { readonly methodName: string },
  sites: readonly RenderSite[], routes: readonly SymfonyRoute[]): ActionRole {
  const declared = frontendIndex(sessions, session).actionsFor(node.className, node.methodName)
    .filter((entry) => entry.projectPath === node.projectPath);
  const action = declared.length === 1 ? declared[0]!.action : undefined;
  if (action?.json === true || routes.some((route) => route.format === 'json')) { return 'jsonRoute'; }
  if (sites.length > 0 || action !== undefined && action.templates.length > 0) { return 'templateRoute'; }
  return 'method';
}

/**
 * The icon for a route row, decided by what the route actually does.
 *
 * The leaf icon claims a template is rendered, so it must never land on an
 * endpoint that renders nothing.
 */
let hierarchy: boolean | undefined;

/**
 * Whether the route sections are grouped by path, read once per turn of the
 * event loop: every route row asks while a tree is drawn, and building a
 * configuration snapshot per row is the cost the colours already avoid.
 */
function routeHierarchyOn(): boolean {
  if (hierarchy === undefined) {
    hierarchy = vscode.workspace.getConfiguration('wicker').get<boolean>('sidebar.routeHierarchy', true);
    queueMicrotask(() => { hierarchy = undefined; });
  }
  return hierarchy;
}

/**
 * The controllers as paths, under the namespace they all share.
 *
 * A namespace every controller has in common separates none of them, so
 * `App\Controller` is folded away and what is left is what a folder row is
 * worth showing. A project that keeps every controller in one namespace is
 * left exactly as it was: there is nothing to group by.
 */
function controllerPaths(sessions: SessionManager, session: ProjectSession):
readonly (RenderingController & { readonly path: string })[] {
  const controllers = controllersInProject(sessions, session);
  const named = controllers.map((controller) => ({ controller, segments: controller.className.split('\\') }));
  const shared = namespacesOn() ? commonPrefix(named.map((entry) => entry.segments.join('/'))).length : Infinity;
  return named.map(({ controller, segments }) => ({ ...controller, path: segments.slice(shared).join('/') }));
}

/** One level of the controller list: the namespaces beneath a path, then the classes that sit in it. */
function controllerLevel(sessions: SessionManager, session: ProjectSession,
  root: vscode.Uri, folder: string): SidebarNode[] {
  const level = pathLevel(controllerPaths(sessions, session), folder);
  return [
    ...level.folders.map((entry) => ({ kind: 'controllerFolder' as const, root, path: entry.path })),
    ...level.leaves.map((entry) => ({ kind: 'controller' as const, root,
      projectPath: entry.projectPath, className: entry.className })),
  ];
}

/** The namespace a folder row stands for, written the way PHP writes it. */
function namespaceOfPath(sessions: SessionManager, session: ProjectSession, path: string): string {
  const example = controllerPaths(sessions, session).find((entry) => entry.path.startsWith(`${path}/`));
  const depth = pathSegments(path).length;
  return example === undefined ? path.replaceAll('/', '\\')
    : example.className.split('\\').slice(0, -pathSegments(example.path).length + depth).join('\\');
}

let namespaces: boolean | undefined;

/** Whether controllers group by namespace, read once per turn of the event loop. */
function namespacesOn(): boolean {
  if (namespaces === undefined) {
    namespaces = vscode.workspace.getConfiguration('wicker').get<boolean>('sidebar.controllerNamespaces', true);
    queueMicrotask(() => { namespaces = undefined; });
  }
  return namespaces;
}

/** One level of a route hierarchy as rows: the folders beneath a path, then the routes that end there. */
function routeLevelNodes(root: vscode.Uri, routes: readonly SymfonyRoute[], folder: string,
  section: 'api' | 'templateRoutes'): SidebarNode[] {
  const level = pathLevel(routes, folder);
  return [
    ...level.folders.map((entry) => ({ kind: 'routeFolder' as const, root, section, path: entry.path })),
    ...level.leaves.map((route) => ({ kind: 'route' as const, root, name: route.name, section })),
  ];
}

function routeIcon(sessions: SessionManager, session: ProjectSession, route: SymfonyRoute): SidebarRole {
  const action = routeAction(sessions, session, route)?.action;
  if (route.format === 'json' || action?.json) { return 'jsonRoute'; }
  return action?.templates.length ? 'templateRoute' : 'route';
}

function warningReasons(session: ProjectSession): WarningReason[] {
  const reasons: WarningReason[] = [];
  // Not yet asked is not unavailable: while the tree waits for the console's
  // first answer it says so in its own row, and warns about nothing.
  const pending = session.consolePending;
  if (!pending && session.loaderPaths.source === 'config') {
    reasons.push('namespaces');
  }
  // Routes, Stimulus controllers and components all come from the console.
  // Without it every one of those sections is simply absent, which reads as a
  // project that has none rather than as an answer nothing could give.
  if (!pending && consoleWarning(session) !== undefined) {
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

/** A row that opens a file: the editor's own open command, and the URI as the
 * row's resource so decorations and drag work as they do in Explorer. */
function opens(item: vscode.TreeItem, uri: vscode.Uri, title: string): vscode.TreeItem {
  item.resourceUri = uri;
  item.command = { command: 'vscode.open', title, arguments: [uri] };
  return item;
}

/** To the clipboard, with a word in the status bar so the click is seen to land. */
async function copied(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(`Copied ${text}`, 3000);
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
