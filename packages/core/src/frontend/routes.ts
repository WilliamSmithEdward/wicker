import { parseJsonLoosely } from '../console/consoleRunner.js';
import { significantTokens, type PhpToken } from '../php/lexer.js';
import { scanTemplateReferences, type OffsetRange } from '../php/templateReferences.js';
import { closingToken } from './javascript.js';

export interface SymfonyRoute {
  readonly name: string;
  readonly path: string;
  readonly methods: string;
  readonly controller: string;
  readonly format: string;
}
export interface ResponseField { readonly name: string; readonly range: OffsetRange; readonly fields: readonly ResponseField[] }
export interface EndpointAction {
  readonly className: string;
  readonly methodName: string;
  readonly range: OffsetRange;
  readonly bodyRange: OffsetRange;
  readonly json: boolean;
  readonly fields: readonly ResponseField[];
  readonly templates: readonly string[];
}

export function routesFromDebug(raw: string): readonly SymfonyRoute[] | undefined {
  const parsed: unknown = parseJsonLoosely(raw);
  if (!record(parsed)) { return undefined; }
  const routes: SymfonyRoute[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!record(value) || typeof value['path'] !== 'string' || !value['path'].startsWith('/') ||
      typeof value['method'] !== 'string' || !record(value['defaults'])) { continue; }
    const controller = value['defaults']['_controller'];
    if (typeof controller !== 'string' || !/^[\w\\]+(?:::\w+)?$/.test(controller)) { continue; }
    routes.push({ name, path: value['path'], methods: value['method'], controller,
      format: typeof value['defaults']['_format'] === 'string' ? value['defaults']['_format'] : '' });
  }
  return routes.length || Object.keys(parsed).length === 0 ? routes : undefined;
}

/** Literal URLs only: ambiguous routes, hosts and runtime path parameters must
 * not become an invented connection. Runtime regexes are never executed. */
export function routeForUrl(routes: readonly SymfonyRoute[], url: string): SymfonyRoute | undefined {
  if (!url.startsWith('/') || url.startsWith('//')) { return undefined; }
  const path = url.split(/[?#]/)[0];
  const matches = routes.filter((route) => !/[{}]/.test(route.path) && route.path === path);
  return matches.length === 1 ? matches[0] : undefined;
}

export function endpointActions(source: string): readonly EndpointAction[] {
  const tokens = significantTokens(source);
  const renders = scanTemplateReferences(source).references;
  const actions: EndpointAction[] = [];
  let namespace = '';
  const jsonAliases = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text === 'use') {
      const parts: string[] = [];
      let j = i + 1;
      while (j < tokens.length && ![';', 'as', '{', ','].includes(tokens[j]!.text)) { parts.push(tokens[j++]!.text); }
      if (parts.join('').replace(/^\\/, '') === 'Symfony\\Component\\HttpFoundation\\JsonResponse') {
        jsonAliases.add(tokens[j]?.text === 'as' ? tokens[j + 1]?.text ?? '' : 'JsonResponse');
      }
    }
    if (tokens[i]!.text === 'namespace') {
      const parts: string[] = [];
      while (++i < tokens.length && ![';', '{'].includes(tokens[i]!.text)) { parts.push(tokens[i]!.text); }
      namespace = parts.join('');
      continue;
    }
    if (tokens[i]!.text !== 'class' || tokens[i - 1]?.text === '::' || tokens[i + 1]?.kind !== 'identifier') { continue; }
    const className = [namespace, tokens[i + 1]!.text].filter(Boolean).join('\\');
    const open = tokens.findIndex((t, j) => j > i && t.text === '{');
    const close = closingToken(tokens, open);
    if (close < 0) { continue; }
    for (let j = open + 1; j < close; j++) {
      if (tokens[j]!.text === 'function' && tokens[j + 1]?.kind === 'identifier' && tokens[j + 2]?.text === '(') {
        const name = tokens[j + 1]!;
        let body = closingToken(tokens, j + 2) + 1;
        while (body > 0 && body < close && !['{', ';'].includes(tokens[body]!.text)) { body++; }
        if (tokens[body]?.text !== '{') { continue; }
        const end = closingToken(tokens, body);
        if (end < 0) { continue; }
        const responses: (readonly ResponseField[])[] = [];
        let json = false;
        for (let k = body + 1; k < end; k++) {
          // Nested functions/classes have their own returns, not this action's.
          if (['function', 'class', 'fn'].includes(tokens[k]!.text)) {
            while (k < end && !['{', ';'].includes(tokens[k]!.text)) { k++; }
            if (tokens[k]?.text === '{') { k = Math.max(k, closingToken(tokens, k)); }
            continue;
          }
          if (tokens[k]!.text !== 'return') { continue; }
          let array = -1;
          if (tokens[k + 1]?.text === '$this' && tokens[k + 2]?.text === '->' &&
            tokens[k + 3]?.text === 'json' && tokens[k + 4]?.text === '(') { json = true; array = k + 5; }
          if (tokens[k + 1]?.text === 'new') {
            let cursor = k + 2, responseClass = '';
            while (cursor < end && (tokens[cursor]!.kind === 'identifier' || tokens[cursor]!.text === '\\')) { responseClass += tokens[cursor++]!.text; }
            if (jsonAliases.has(responseClass) || responseClass === '\\Symfony\\Component\\HttpFoundation\\JsonResponse') {
              json = true; array = tokens[cursor]?.text === '(' ? cursor + 1 : -1;
            }
          }
          if (tokens[array]?.text === 'data' && tokens[array + 1]?.text === ':') { array += 2; }
          responses.push(array >= 0 ? responseFields(tokens, array, 0) : []);
        }
        actions.push({ className, methodName: name.text, range: name,
          bodyRange: { start: tokens[body]!.start, end: tokens[end]!.end }, json,
          fields: intersectFields(responses), templates: [...new Set(renders.filter((r) => r.className === className && r.methodName === name.text).map((r) => r.templateName))] });
        j = end;
      } else if (tokens[j]!.text === '{') { j = Math.max(j, closingToken(tokens, j)); }
    }
    i = close;
  }
  return actions;
}

function responseFields(tokens: readonly PhpToken[], open: number, depth: number): readonly ResponseField[] {
  if (tokens[open]?.text !== '[' || depth > 8) { return []; }
  const end = closingToken(tokens, open);
  if (end < 0) { return []; }
  const fields: ResponseField[] = [];
  for (let i = open + 1; i < end; i++) {
    const token = tokens[i]!;
    if (token.kind === 'string' && tokens[i + 1]?.text === '=>' && token.value !== undefined &&
      ['[', ','].includes(tokens[i - 1]?.text ?? '')) {
      fields.push({ name: token.value, range: { start: token.contentStart!, end: token.contentEnd! }, fields: responseFields(tokens, i + 2, depth + 1) });
      i += 2;
    } else if (i === open + 1 && token.text === '[') {
      fields.push({ name: '[]', range: token, fields: responseFields(tokens, i, depth + 1) });
    }
    if (tokens[i]?.text === '...') { return []; }
    if (['[', '(', '{'].includes(tokens[i]?.text ?? '')) { const close = closingToken(tokens, i); if (close < 0) { return []; } i = close; }
  }
  return fields;
}

function intersectFields(responses: readonly (readonly ResponseField[])[]): readonly ResponseField[] {
  return (responses[0] ?? []).filter((field) => responses.every((response) => response.some((entry) => entry.name === field.name)))
    .map((field) => ({ ...field, fields: intersectFields(responses.map((response) => response.find((entry) => entry.name === field.name)!.fields)) }));
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
