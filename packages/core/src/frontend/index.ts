import type { OffsetRange } from '../php/templateReferences.js';
import { phpTypeDeclarations, type PhpTypeDeclaration } from '../php/dependencies.js';
import { scanTwigTemplateReferences, type TwigTemplateReference } from '../twig/twigReferences.js';
import { lexTwigRegions } from '../twig/twigLexer.js';
import { javascriptTokens } from './javascript.js';
import { scanFrontend, stimulusHtmlName, type FrontendReference, type FrontendScan } from './references.js';
import { endpointActions, routeForUrl, type EndpointAction, type SymfonyRoute } from './routes.js';
import type { StimulusController } from './stimulus.js';

export interface FrontendFile {
  readonly projectPath: string;
  readonly source: string;
  readonly scan: FrontendScan;
  readonly actions: readonly EndpointAction[];
  readonly types: readonly PhpTypeDeclaration[];
  readonly templateReferences: readonly TwigTemplateReference[];
}
export interface EndpointUse { readonly projectPath: string; readonly range: OffsetRange; readonly via?: string }

export class FrontendIndex {
  private readonly files = new Map<string, FrontendFile>();
  update(projectPath: string, source: string): void {
    this.files.set(projectPath, { projectPath, source, scan: /\.(?:twig|js|ts)$/.test(projectPath)
      ? scanFrontend(source, projectPath.endsWith('.twig')) : { references: [], requests: [], bindings: [], scripts: [] },
    actions: projectPath.endsWith('.php') ? endpointActions(source) : [],
    types: projectPath.endsWith('.php') ? phpTypeDeclarations(source) : [],
    templateReferences: projectPath.endsWith('.twig') ? activeTemplateReferences(source) : [] });
  }
  remove(projectPath: string): void { this.files.delete(projectPath); }
  sourcePaths(): string[] { return [...this.files.keys()]; }
  all(): readonly FrontendFile[] { return [...this.files.values()]; }
  get(projectPath: string): FrontendFile | undefined { return this.files.get(projectPath); }
  filtered(owns: (path: string) => boolean): FrontendIndex {
    const result = new FrontendIndex();
    for (const [path, file] of this.files) { if (owns(path)) { result.files.set(path, file); } }
    return result;
  }

  consumers(route: SymfonyRoute, routes: readonly SymfonyRoute[], controllers: readonly StimulusController[]): readonly EndpointUse[] {
    const uses: EndpointUse[] = [];
    for (const file of this.files.values()) {
      for (const ref of file.scan.references) {
        if (this.resolve(ref, routes)?.name === route.name) { uses.push({ projectPath: file.projectPath, range: ref.range }); }
      }
      for (const value of fetchValueReferences(file.source, file.scan.scripts)) {
        const connected = this.routesForValue(file.projectPath, value.name, routes, controllers);
        if (connected.some((entry) => entry.name === route.name)) {
          uses.push({ projectPath: file.projectPath, range: value.range, via: 'Stimulus value' });
        }
      }
    }
    return uses;
  }
  resolve(ref: FrontendReference, routes: readonly SymfonyRoute[]): SymfonyRoute | undefined {
    return ref.kind === 'route' ? routes.find((route) => route.name === ref.name) : ref.kind === 'url' ? routeForUrl(routes, ref.name) : undefined;
  }
  routesForValue(projectPath: string, property: string, routes: readonly SymfonyRoute[], controllers: readonly StimulusController[]): readonly SymfonyRoute[] {
    const names = controllers.filter((controller) => controller.projectPath === projectPath).map((controller) => controller.name);
    const result = new Map<string, SymfonyRoute>();
    for (const file of this.files.values()) {
      for (const binding of file.scan.bindings) {
        if (names.some((name) => binding.controller === name && binding.value === property ||
          binding.controller === '' && binding.value === `${name}-${stimulusHtmlName(property)}`)) {
          const route = this.resolve(binding.endpoint, routes);
          if (route) { result.set(route.name, route); }
        }
      }
    }
    return [...result.values()];
  }
}

function activeTemplateReferences(source: string): readonly TwigTemplateReference[] {
  const ignored: OffsetRange[] = [];
  let verbatim = false;
  for (const region of lexTwigRegions(source)) {
    if (verbatim) { ignored.push(region); }
    if (region.kind !== 'statement') { continue; }
    const tag = source.slice(region.innerStart, region.innerEnd).trim();
    if (/^verbatim\b/.test(tag)) { verbatim = true; }
    else if (/^endverbatim\b/.test(tag)) { verbatim = false; }
  }
  return scanTwigTemplateReferences(source).filter((ref) => !ignored.some((range) => ref.range.start >= range.start && ref.range.end <= range.end));
}

export function fetchValueReferences(source: string, scripts: readonly OffsetRange[]): readonly { name: string; range: OffsetRange }[] {
  return scripts.flatMap((script) => {
    const tokens = javascriptTokens(source, script.start, script.end);
    return tokens.flatMap((token, i) => token.text === 'fetch' && tokens[i + 1]?.text === '(' &&
      (!['.', '?.'].includes(tokens[i - 1]?.text ?? '') || ['window', 'globalThis'].includes(tokens[i - 2]?.text ?? '')) &&
      tokens[i + 2]?.text === 'this' && tokens[i + 3]?.text === '.' && tokens[i + 4]?.text.endsWith('Value') &&
      [')', ','].includes(tokens[i + 5]?.text ?? '')
      ? [{ name: tokens[i + 4]!.text.slice(0, -5), range: tokens[i + 4]! }] : []);
  });
}
