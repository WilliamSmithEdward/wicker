import type { RenderSiteIndex } from '../php/renderSiteIndex.js';
import type { OffsetRange } from '../php/templateReferences.js';
import { normalizeProjectPath } from '../util/paths.js';

import { templateContextVariables, twigScopeAt } from './contextVariables.js';
import { isTwigVariableName, literalTwigString, splitTwigTokens, twigContextMap, type ContextKey } from './contextSyntax.js';
import { tokenizeTwigExpression, type TwigExpressionToken as Token } from './expressionLexer.js';
import type { TwigTemplateIndex } from './templateIndex.js';
import { lexTwigRegions } from './twigLexer.js';

export interface TwigContextStep {
  readonly projectPath: string;
  readonly range: OffsetRange;
  readonly kind: 'include' | 'include-function' | 'extends';
}

export interface TwigVariableOrigin {
  readonly projectPath: string;
  readonly range: OffsetRange;
  readonly kind: 'controller' | 'set' | 'loop' | 'macro' | 'with' | 'import' | 'include';
  readonly label: string;
  readonly via: readonly TwigContextStep[];
}

export interface TwigContextVariable {
  readonly name: string;
  readonly origins: readonly TwigVariableOrigin[];
}

interface ContextEdge extends TwigContextStep {
  readonly templateName: string;
  readonly offset: number;
  readonly inherit: boolean;
  readonly keys: readonly ContextKey[];
}

interface TemplateRecord {
  readonly source: string;
  readonly edges: readonly ContextEdge[];
  readonly blocks: ReadonlyMap<string, number>;
}

interface Query {
  readonly templates: TwigTemplateIndex;
  readonly renders: RenderSiteIndex;
  readonly owns: (path: string) => boolean;
  remaining: number;
}

type Variables = Map<string, TwigContextVariable>;

/**
 * Name evidence across literal Twig rendering edges. Values and types are not
 * inferred. A union describes possible callers, never guaranteed runtime input.
 */
export class TemplateContextIndex {
  private readonly records = new Map<string, TemplateRecord>();
  private readonly byTargetName = new Map<string, Set<ContextEdge>>();
  private sourceSize = 0;

  update(projectPath: string, source: string): void {
    const path = normalizeProjectPath(projectPath);
    if (path === undefined || this.records.get(path)?.source === source) { return; }
    this.remove(path);
    // Bound retained text and graph walks even for generated/vendor templates.
    if (source.length > 512 * 1024 || this.sourceSize + source.length > 32 * 1024 * 1024) { return; }
    const parsed = parseTemplate(path, source);
    this.records.set(path, parsed);
    this.sourceSize += source.length;
    for (const edge of parsed.edges) {
      const incoming = this.byTargetName.get(edge.templateName) ?? new Set<ContextEdge>();
      incoming.add(edge);
      this.byTargetName.set(edge.templateName, incoming);
    }
  }

  remove(projectPath: string): void {
    const record = this.records.get(projectPath);
    if (record === undefined) { return; }
    this.sourceSize -= record.source.length;
    this.records.delete(projectPath);
    for (const edge of record.edges) {
      const incoming = this.byTargetName.get(edge.templateName);
      incoming?.delete(edge);
      if (incoming?.size === 0) { this.byTargetName.delete(edge.templateName); }
    }
  }

  sourcePaths(): readonly string[] { return [...this.records.keys()]; }

  variablesFor(projectPath: string, offset: number, templates: TwigTemplateIndex,
    renders: RenderSiteIndex, owns: (path: string) => boolean = () => true): readonly TwigContextVariable[] {
    return [...this.visible(projectPath, offset, { templates, renders, owns, remaining: 256 }, new Set()).values()]
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private visible(path: string, offset: number, query: Query, visited: ReadonlySet<string>): Variables {
    const record = this.records.get(path);
    if (record === undefined || !query.owns(path) || visited.has(path) || visited.size >= 16 || query.remaining-- <= 0) {
      return new Map();
    }
    const next = new Set([...visited, path]);
    const scope = twigScopeAt(record.source, offset);
    const variables: Variables = new Map();
    if (!scope.isolated) {
      const sites = query.renders.forTemplate(path, query.templates).filter((site) => query.owns(site.projectPath));
      for (const variable of templateContextVariables(sites)) {
        merge(variables, { name: variable.name, origins: variable.sources.map((site) => ({
          kind: 'controller', projectPath: site.projectPath, range: site.nameRange, via: [],
          label: site.methodName === undefined ? site.projectPath : `${site.className?.split('\\').at(-1) ?? 'Controller'}::${site.methodName}`,
        })) });
      }
      for (const name of query.templates.namesForProjectPath(path)) {
        if (query.templates.lookup(name)?.projectPath !== path) { continue; }
        for (const edge of this.byTargetName.get(name) ?? []) {
          if (!query.owns(edge.projectPath) || query.templates.namesForProjectPath(edge.projectPath).length === 0) { continue; }
          const caller = this.records.get(edge.projectPath);
          if (caller === undefined) { continue; }
          const incoming = edge.inherit ? this.visible(edge.projectPath,
            edge.kind === 'extends' ? caller.source.length : edge.offset, query, next) : new Map<string, TwigContextVariable>();
          for (const [key, variable] of incoming) {
            incoming.set(key, { name: key, origins: variable.origins.map((origin) => ({ ...origin, via: [...origin.via, edge] })) });
          }
          for (const key of edge.keys) {
            incoming.set(key.name, { name: key.name, origins: [{ kind: 'include', projectPath: edge.projectPath,
              range: key.range, label: edge.kind === 'include-function' ? 'include() arguments' : 'include with', via: [edge] }] });
          }
          for (const variable of incoming.values()) { merge(variables, variable); }
        }
      }
      if (scope.blockName !== undefined) {
        // Child top-level assignments run before its blocks are rendered by the
        // parent, including assignments written after a block declaration.
        if (record.edges.some((edge) => edge.kind === 'extends')) {
          this.applyLocals(variables, path, record.source.length);
          this.parentBindings(variables, record, scope.blockName, query, new Set([path]));
        }
      }
    }
    const inheritedOverrides = new Set<string>();
    const blockStart = scope.blockName === undefined ? undefined : record.blocks.get(scope.blockName);
    if (blockStart !== undefined) {
      for (const binding of scope.bindings) {
        if (binding.range.start < blockStart && variables.get(binding.name)?.origins.some((origin) =>
          origin.projectPath !== path && origin.kind !== 'controller' && origin.via.some((step) => step.kind === 'extends'))) {
          inheritedOverrides.add(binding.name);
        }
      }
    }
    for (const name of scope.localNames) { if (!inheritedOverrides.has(name)) { variables.delete(name); } }
    this.applyLocals(variables, path, offset, inheritedOverrides);
    return variables;
  }

  private applyLocals(variables: Variables, path: string, offset: number, skip: ReadonlySet<string> = new Set()): void {
    const record = this.records.get(path);
    if (record === undefined) { return; }
    for (const binding of twigScopeAt(record.source, offset).bindings) {
      if (!isTwigVariableName(binding.name) || binding.kind === 'import' || skip.has(binding.name)) { continue; }
      variables.set(binding.name, { name: binding.name, origins: [{ ...binding,
        projectPath: path, label: `Twig ${binding.kind}`, via: [],
      }] });
    }
  }

  private parentBindings(variables: Variables, child: TemplateRecord, block: string, query: Query, visited: Set<string>): void {
    const parents = child.edges.filter((edge) => edge.kind === 'extends');
    if (parents.length !== 1 || visited.size >= 16 || query.remaining-- <= 0) { return; }
    const edge = parents[0]!;
    const parentPath = query.templates.lookup(edge.templateName)?.projectPath;
    if (parentPath === undefined || !query.owns(parentPath) || visited.has(parentPath)) { return; }
    const parent = this.records.get(parentPath);
    if (parent === undefined) { return; }
    visited.add(parentPath);
    const parentExtends = parent.edges.some((item) => item.kind === 'extends');
    const offset = parentExtends ? parent.source.length : parent.blocks.get(block);
    if (offset === undefined) { return; }
    const inherited: Variables = new Map();
    this.applyLocals(inherited, parentPath, offset);
    for (const [name, variable] of inherited) {
      variables.set(name, { name, origins: variable.origins.map((origin) => ({ ...origin, via: [edge] })) });
    }
    this.parentBindings(variables, parent, block, query, visited);
  }
}

function merge(variables: Variables, variable: TwigContextVariable): void {
  const origins = [...(variables.get(variable.name)?.origins ?? [])];
  for (const origin of variable.origins) {
    const key = originKey(origin);
    if (origins.length < 16 && !origins.some((item) => originKey(item) === key)) { origins.push(origin); }
  }
  variables.set(variable.name, { name: variable.name, origins });
}

function originKey(origin: TwigVariableOrigin): string {
  return `${origin.projectPath}:${origin.range.start}:${origin.kind}:${origin.via.map((step) => `${step.projectPath}:${step.range.start}`).join('>')}`;
}

function parseTemplate(projectPath: string, source: string): TemplateRecord {
  const edges: ContextEdge[] = [];
  const blocks = new Map<string, number>();
  let verbatim = false;
  for (const region of lexTwigRegions(source)) {
    if (region.kind !== 'expression' && region.kind !== 'statement') { continue; }
    const tokens = tokenizeTwigExpression(source, region.innerStart, region.innerEnd)
      .filter((token) => !(token.kind === 'string' && token.value.startsWith('#')));
    const tag = region.kind === 'statement' ? tokens[0]?.value : undefined;
    if (verbatim) { if (tag === 'endverbatim') { verbatim = false; } continue; }
    if (tag === 'verbatim') { verbatim = true; continue; }
    if (tag === 'block' && tokens[1]?.kind === 'name') { blocks.set(tokens[1].value, region.start); }
    if (tag === 'include' || tag === 'extends') {
      const templateName = literalTwigString(tokens[1]);
      if (templateName !== undefined) {
        let tail = tokens.slice(2);
        if (tail[0]?.value === 'ignore' && tail[1]?.value === 'missing') { tail = tail.slice(2); }
        const only = tail.at(-1)?.value === 'only';
        if (only) { tail = tail.slice(0, -1); }
        const context = tail[0]?.value === 'with' ? twigContextMap(tail.slice(1)) : undefined;
        if ((tag === 'extends' && tokens.length === 2) ||
            (tag === 'include' && (tail.length === 0 || context !== undefined))) {
          edges.push({ kind: tag, projectPath, templateName, offset: region.start,
            range: { start: tokens[1]!.start, end: tokens[1]!.end },
            inherit: !only && (context?.complete ?? true), keys: context?.keys ?? [] });
        }
      }
    }
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]?.value !== 'include' || tokens[i + 1]?.value !== '(' ||
          ['.', '?.', '|', 'is'].includes(tokens[i - 1]?.value ?? '')) { continue; }
      let depth = 1;
      let end = i + 2;
      for (; end < tokens.length; end++) {
        if (tokens[end]?.value === '(') { depth++; }
        else if (tokens[end]?.value === ')' && --depth === 0) { break; }
      }
      if (depth !== 0) { continue; }
      const args = new Map<string, readonly Token[]>();
      splitTwigTokens(tokens.slice(i + 2, end), ',').forEach((argument, index) => {
        if (argument[0]?.kind === 'name' && [':', '='].includes(argument[1]?.value ?? '')) {
          args.set(argument[0].value.replace(/_/g, '').toLowerCase(), argument.slice(2));
        } else { args.set(['template', 'variables', 'withcontext', 'ignoremissing', 'sandboxed'][index] ?? 'unknown', argument); }
      });
      const target = args.get('template');
      const templateName = target?.length === 1 ? literalTwigString(target[0]) : undefined;
      if (templateName === undefined) { continue; }
      const context = args.has('variables') ? twigContextMap(args.get('variables')!) : undefined;
      const withContext = args.get('withcontext');
      edges.push({ kind: 'include-function', projectPath, templateName, offset: tokens[i]!.start,
        range: { start: target![0]!.start, end: target![0]!.end }, keys: context?.keys ?? [],
        inherit: (context?.complete ?? true) && (withContext === undefined || (withContext.length === 1 && withContext[0]?.value === 'true')) });
    }
  }
  return { source, edges, blocks };
}
