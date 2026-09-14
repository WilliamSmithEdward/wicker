import { significantTokens, type PhpToken } from './lexer.js';
import type { OffsetRange } from './templateReferences.js';
import { closingToken } from '../frontend/javascript.js';

export interface PhpDependency {
  readonly typeName: string;
  readonly variable: string;
  /** Undefined for a property declaration. */
  readonly methodName?: string;
}
export interface PhpTypeDeclaration {
  readonly name: string;
  readonly kind: 'class' | 'interface' | 'enum';
  readonly range: OffsetRange;
  readonly dependencies: readonly PhpDependency[];
}

const NAME = /^\\?[a-zA-Z_\u0080-\uffff][\w\u0080-\uffff]*(?:\\[a-zA-Z_\u0080-\uffff][\w\u0080-\uffff]*)*$/;
const BUILTINS = new Set(['array', 'bool', 'callable', 'false', 'float', 'int', 'iterable', 'mixed', 'never', 'null', 'object', 'parent', 'self', 'static', 'string', 'true', 'void']);
const MODIFIERS = new Set(['public', 'protected', 'private', 'readonly', 'var']);

/** Declared, direct dependencies only. This small PHP subset powers a Symfony
 * controller tree; it does not infer container wiring, inheritance or dataflow.
 * Ambiguous union/intersection types are omitted rather than choosing a target.
 * Names resolve against imports, never against a guessed file path. */
export function phpTypeDeclarations(source: string): readonly PhpTypeDeclaration[] {
  const tokens = significantTokens(source);
  const result: PhpTypeDeclaration[] = [];
  const scope = (start: number, end: number, initialNamespace: string): void => {
    let namespace = initialNamespace;
    let imports = new Map<string, string>();
    for (let i = start; i < end; i++) {
      const word = tokens[i]!.text.toLowerCase();
      if (word === 'namespace' && tokens[i + 1]?.text !== '\\') {
        let j = i + 1;
        while (j < end && ![';', '{'].includes(tokens[j]!.text)) { j++; }
        const name = tokens.slice(i + 1, j).map((t) => t.text).join('');
        if (name && !NAME.test(name)) { continue; }
        if (tokens[j]?.text === '{') {
          const close = closingToken(tokens, j);
          if (close < 0) { break; }
          scope(j + 1, close, name); i = close;
        } else { namespace = name; imports = new Map(); i = j; }
        continue;
      }
      if (word === 'use') {
        let j = i + 1;
        while (j < end && tokens[j]!.text !== ';') { j++; }
        readImports(tokens.slice(i + 1, j), imports); i = j; continue;
      }
      if (['class', 'interface', 'enum'].includes(word) && tokens[i - 1]?.text !== '::' &&
        tokens[i - 1]?.text.toLowerCase() !== 'new' && tokens[i + 1]?.kind === 'identifier') {
        const name = tokens[i + 1]!;
        let open = i + 2;
        while (open < end && !['{', ';'].includes(tokens[open]!.text)) { open++; }
        const close = closingToken(tokens, open);
        if (close < 0) { break; }
        result.push({ name: [namespace, name.text].filter(Boolean).join('\\'),
          kind: word as PhpTypeDeclaration['kind'], range: { start: name.start, end: name.end },
          dependencies: members(tokens.slice(open + 1, close), namespace, imports) });
        i = close;
      } else if (['{', '(', '[', '#['].includes(tokens[i]!.text)) {
        const close = closingToken(tokens, i);
        if (close < 0) { break; }
        i = close;
      }
    }
  };
  scope(0, tokens.length, '');
  return result;
}

function readImports(tokens: readonly PhpToken[], imports: Map<string, string>): void {
  for (const entry of split(tokens)) {
    const group = entry.findIndex((t) => t.text === '{');
    const prefix = group < 0 ? '' : entry.slice(0, group).map((t) => t.text).join('');
    const entries = group < 0 ? [entry] : split(entry.slice(group + 1, -1));
    for (const parts of entries) {
      if (['function', 'const'].includes(parts[0]?.text.toLowerCase() ?? '') ||
        ['function', 'const'].includes(entry[0]?.text.toLowerCase() ?? '')) { continue; }
      const as = parts.findIndex((t) => t.text.toLowerCase() === 'as');
      const name = (prefix + (as < 0 ? parts : parts.slice(0, as)).map((t) => t.text).join('')).replace(/^\\/, '');
      const alias = as < 0 ? name.split('\\').at(-1)! : parts[as + 1]?.text;
      if (NAME.test(name) && alias && NAME.test(alias) && (as < 0 || as + 2 === parts.length)) {
        imports.set(alias.toLowerCase(), name);
      }
    }
  }
}

function split(tokens: readonly PhpToken[]): PhpToken[][] {
  const result: PhpToken[][] = [[]];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text === ',') { result.push([]); continue; }
    const close = closingToken(tokens, i);
    if (close >= 0) { result.at(-1)!.push(...tokens.slice(i, close + 1)); i = close; }
    else { result.at(-1)!.push(tokens[i]!); }
  }
  return result.filter((entry) => entry.length);
}

function members(tokens: readonly PhpToken[], namespace: string, imports: ReadonlyMap<string, string>): PhpDependency[] {
  const result: PhpDependency[] = [];
  let member: PhpToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === '#[') {
      const close = closingToken(tokens, i); if (close < 0) { break; } i = close; continue;
    }
    if (token.text.toLowerCase() === 'function') {
      const nameAt = tokens[i + 1]?.text === '&' ? i + 2 : i + 1;
      const method = tokens[nameAt];
      const open = nameAt + 1, close = closingToken(tokens, open);
      if (method?.kind !== 'identifier' || tokens[open]?.text !== '(' || close < 0) { break; }
      if (!member.some((t) => t.text.toLowerCase() === 'static')) {
        for (const param of split(tokens.slice(open + 1, close))) {
          result.push(...dependencies(param, namespace, imports, method.text));
        }
      }
      i = close;
      while (i + 1 < tokens.length && !['{', ';'].includes(tokens[i + 1]!.text)) { i++; }
      if (tokens[i + 1]?.text === '{') {
        const end = closingToken(tokens, i + 1); if (end < 0) { break; } i = end;
      } else { i++; }
      member = [];
    } else if (token.text === ';') {
      // The first variable carries a property's type; comma-separated properties
      // share it. Initializers stay opaque and cannot introduce dependencies.
      const entries = split(member);
      const first = entries[0] ?? [];
      const variable = first.findIndex((t) => t.kind === 'variable');
      if (variable >= 0) {
        result.push(...dependencies(first, namespace, imports));
        for (const entry of entries.slice(1)) { result.push(...dependencies([...first.slice(0, variable), ...entry], namespace, imports)); }
      }
      member = [];
    } else if (['{', '[', '('].includes(token.text)) {
      const close = closingToken(tokens, i); if (close < 0) { break; }
      // Property hooks are outside this subset; skip them entirely.
      if (token.text === '{') { member = []; } else { member.push(...tokens.slice(i, close + 1)); }
      i = close;
    } else { member.push(token); }
  }
  return result;
}

function dependencies(tokens: readonly PhpToken[], namespace: string, imports: ReadonlyMap<string, string>, methodName?: string): PhpDependency[] {
  const prefix: PhpToken[] = [];
  let variable: PhpToken | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === 'variable') { variable = token; break; }
    if (token.text === '#[') { const close = closingToken(tokens, i); if (close < 0) { return []; } i = close; }
    else { prefix.push(token); }
  }
  if (!variable) { return []; }
  if (prefix.some((t) => ['static', 'const', 'use'].includes(t.text.toLowerCase()))) { return []; }
  const type = prefix.filter((t) => !MODIFIERS.has(t.text.toLowerCase()));
  if (type.at(-1)?.text === '...') { type.pop(); }
  if (type.at(-1)?.text === '&') { type.pop(); }
  if (type[0]?.text === '?') { type.shift(); }
  const name = type.map((t) => t.text).join('');
  if (!NAME.test(name) || BUILTINS.has(name.toLowerCase())) { return []; }
  const parts = name.split('\\');
  const alias = imports.get(parts[0]!.toLowerCase());
  const typeName = name.startsWith('\\') ? name.slice(1) : parts[0]?.toLowerCase() === 'namespace'
    ? [namespace, ...parts.slice(1)].filter(Boolean).join('\\') : alias
      ? [alias, ...parts.slice(1)].join('\\') : [namespace, name].filter(Boolean).join('\\');
  return [{ typeName, variable: variable.text, ...(methodName ? { methodName } : {}) }];
}
