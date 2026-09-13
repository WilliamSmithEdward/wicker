import type { TwigTemplateIndex } from '../twig/templateIndex.js';
import { normalizeProjectPath } from '../util/paths.js';

import { scanTemplateReferences, type TemplateReference } from './templateReferences.js';

/** A PHP render call or Template attribute, with its project-relative source file. */
export interface RenderSite extends TemplateReference {
  readonly projectPath: string;
}

export interface RenderingController {
  readonly projectPath: string;
  readonly className: string;
  readonly sites: readonly RenderSite[];
}

/**
 * The reverse half of template navigation. Source edits replace one file's
 * records; template resolution is checked at query time so loader changes and
 * overrides cannot leave links pointing at the wrong template.
 */
export class RenderSiteIndex {
  private readonly bySource = new Map<string, readonly RenderSite[]>();
  private readonly byTemplateName = new Map<string, Set<RenderSite>>();

  update(projectPath: string, source: string): void {
    const path = normalizeProjectPath(projectPath);
    if (path === undefined) {
      return;
    }
    this.remove(path);
    const sites = scanTemplateReferences(source).references.map((reference) => ({
      ...reference,
      projectPath: path,
    }));
    if (sites.length === 0) {
      return;
    }
    this.bySource.set(path, sites);
    for (const site of sites) {
      let entries = this.byTemplateName.get(site.templateName);
      if (entries === undefined) {
        entries = new Set();
        this.byTemplateName.set(site.templateName, entries);
      }
      entries.add(site);
    }
  }

  remove(projectPath: string): void {
    const path = normalizeProjectPath(projectPath);
    if (path === undefined) {
      return;
    }
    for (const site of this.bySource.get(path) ?? []) {
      const entries = this.byTemplateName.get(site.templateName);
      entries?.delete(site);
      if (entries?.size === 0) {
        this.byTemplateName.delete(site.templateName);
      }
    }
    this.bySource.delete(path);
  }

  sourcePaths(): readonly string[] {
    return [...this.bySource.keys()];
  }

  /**
   * Controllers following Symfony's Controller directory/namespace or class
   * suffix convention. This is a view of literal renders, not a PHP class or
   * route index: services, dynamic names and methods without renders stay out.
   */
  controllers(): readonly RenderingController[] {
    const controllers: RenderingController[] = [];
    for (const [projectPath, sites] of this.bySource) {
      const byClass = new Map<string, RenderSite[]>();
      for (const site of sites) {
        if (site.className === undefined || site.methodName === undefined ||
          !(site.className.endsWith('Controller') || site.className.split('\\').includes('Controller') ||
            projectPath.split('/').slice(0, -1).includes('Controller'))) {
          continue;
        }
        const group = byClass.get(site.className) ?? [];
        group.push(site);
        byClass.set(site.className, group);
      }
      for (const [className, references] of byClass) {
        controllers.push({ projectPath, className, sites: references });
      }
    }
    return controllers.sort((a, b) => a.className.localeCompare(b.className) || a.projectPath.localeCompare(b.projectPath));
  }

  forTemplate(projectPath: string, templates: TwigTemplateIndex): readonly RenderSite[] {
    const path = normalizeProjectPath(projectPath);
    if (path === undefined) {
      return [];
    }
    const sites: RenderSite[] = [];
    for (const name of templates.namesForProjectPath(path)) {
      if (templates.lookup(name)?.projectPath === path) {
        sites.push(...(this.byTemplateName.get(name) ?? []));
      }
    }
    return sites.sort((a, b) =>
      a.projectPath.localeCompare(b.projectPath) || a.nameRange.start - b.nameRange.start,
    );
  }
}
