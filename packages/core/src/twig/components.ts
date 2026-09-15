import { tokenizePhp, type PhpToken } from '../php/lexer.js';
import type { OffsetRange } from '../php/templateReferences.js';

import { splitTwigTokens, isTwigVariableName } from './contextSyntax.js';
import { tokenizeTwigExpression } from './expressionLexer.js';
import { parseTemplateName } from './templateName.js';
import { lexTwigRegions } from './twigLexer.js';

export interface TwigComponent {
  readonly name: string;
  readonly className: string | undefined;
  readonly template: string;
  readonly live: boolean;
}

export interface ComponentProp {
  readonly name: string;
  readonly range: OffsetRange;
  readonly kind: 'property' | 'setter' | 'mount' | 'props';
}

const COMPONENT_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z_][a-zA-Z0-9_]*)*$/;
function isComponentName(name: string): boolean {
  return name.length <= 256 && COMPONENT_NAME.test(name);
}

/**
 * debug:twig-component has no JSON formatter (UX 2.x/3.x). Read its unstyled
 * four-column table, declining wrapped/malformed rows instead of inferring
 * registrations from naming conventions. An unavailable table is not empty.
 */
export function componentsFromDebug(output: string): readonly TwigComponent[] | undefined {
  const result = new Map<string, TwigComponent>();
  let table = false;
  for (const line of output.split(/\r?\n/)) {
    const cells = line.trim().split('|').map((cell) => cell.trim());
    if (cells.length !== 6 || cells[0] !== '' || cells[5] !== '') { continue; }
    const [name, className, template, type] = cells.slice(1, 5) as [string, string, string, string];
    if ([name, className, template, type].join('|') === 'Name|Class|Template|Type') { table = true; continue; }
    if (!table || !isComponentName(name) || template.length > 2048 || !parseTemplateName(template).ok ||
      !['', 'Anon', 'Live'].includes(type) ||
      (className !== '' && !/^\\?[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*(?:\\[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*)*$/.test(className))) { continue; }
    result.set(name, { name, className: className || undefined, template, live: type === 'Live' });
    if (result.size >= 20000) { break; }
  }
  return table ? [...result.values()].sort((a, b) => a.name.localeCompare(b.name)) : undefined;
}

/** Explicit {% props %} declarations; defaults and nested expressions are opaque. */
export function anonymousComponentProps(source: string): readonly ComponentProp[] {
  if (source.length > 512 * 1024) { return []; }
  const props: ComponentProp[] = [];
  let verbatim = false;
  for (const region of lexTwigRegions(source)) {
    if (region.kind !== 'statement') { continue; }
    const tokens = tokenizeTwigExpression(source, region.innerStart, region.innerEnd);
    const tag = tokens[0]?.value;
    if (tag === 'endverbatim') { verbatim = false; continue; }
    if (verbatim) { continue; }
    if (tag === 'verbatim') { verbatim = true; continue; }
    if (tag !== 'props') { continue; }
    for (const entry of splitTwigTokens(tokens.slice(1), ',')) {
      const first = entry[0];
      if (first?.kind === 'name' && isTwigVariableName(first.value) &&
        (entry.length === 1 || entry[1]?.value === '=')) {
        props.push({ name: first.value, range: first, kind: 'props' });
      }
    }
  }
  return props;
}

export interface ComponentClassSource {
  readonly range: OffsetRange;
  readonly props: readonly ComponentProp[];
}

/**
 * The registered class's own writable public properties, setters and mount
 * inputs. This deliberately does not infer inheritance, traits, property hooks
 * or dynamic PreMount behavior; those require broader PHP type knowledge.
 */
export function componentClassSource(source: string, className: string): ComponentClassSource | undefined {
  if (source.length > 512 * 1024) { return undefined; }
  const tokens = tokenizePhp(source).filter((token) => token.kind !== 'comment');
  let namespace = '';
  for (let at = 0; at < tokens.length; at++) {
    if (tokens[at]?.text.toLowerCase() === 'namespace') {
      namespace = '';
      while (++at < tokens.length && ![';', '{'].includes(tokens[at]?.text ?? '')) { namespace += tokens[at]?.text ?? ''; }
    }
    if (tokens[at]?.text.toLowerCase() !== 'class' || tokens[at - 1]?.text === '::') { continue; }
    const name = tokens[at + 1];
    if (name?.kind !== 'identifier' || `${namespace ? `${namespace}\\` : ''}${name.text}` !== className.replace(/^\\/, '')) { continue; }
    let body = at + 2;
    while (body < tokens.length && tokens[body]?.text !== '{') { body++; }
    const end = paired(tokens, body, '{', '}');
    if (end === undefined) { return undefined; }
    const readonlyClass = tokens[at - 1]?.text.toLowerCase() === 'readonly';
    return { range: name, props: classProps(tokens.slice(body + 1, end), readonlyClass) };
  }
  return undefined;
}

function paired(tokens: readonly PhpToken[], at: number, open: string, close: string): number | undefined {
  let depth = 0;
  for (let i = at; i < tokens.length; i++) {
    if (tokens[i]?.text === open) { depth++; }
    if (tokens[i]?.text === close && --depth === 0) { return i; }
  }
  return undefined;
}

function classProps(tokens: readonly PhpToken[], readonlyClass: boolean): readonly ComponentProp[] {
  const props = new Map<string, ComponentProp>();
  let member: PhpToken[] = [];
  const add = (token: PhpToken, kind: ComponentProp['kind'], name = token.text.slice(1)): void => {
    if (isTwigVariableName(name) && !props.has(name)) {
      props.set(name, { name, kind, range: { start: token.start + (token.kind === 'variable' ? 1 : 0), end: token.end } });
    }
  };
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token.kind === 'attribute-open') {
      // #[...] includes nested arrays; the opener counts as its first bracket.
      let depth = 1;
      while (++at < tokens.length && depth > 0) {
        if (tokens[at]?.text === '[') { depth++; }
        if (tokens[at]?.text === ']') { depth--; }
      }
      at--;
      continue;
    }
    if (token.text.toLowerCase() === 'function') {
      const visibility = member.map((part) => part.text.toLowerCase());
      const isPublic = !visibility.some((part) => ['private', 'protected', 'static'].includes(part));
      const method = tokens[at + 1];
      let open = at + 2;
      if (method?.text === '&') { open++; }
      const close = tokens[open]?.text === '(' ? paired(tokens, open, '(', ')') : undefined;
      if (close === undefined) { return [...props.values()]; }
      const params = splitPhpParameters(tokens.slice(open + 1, close));
      if (isPublic && method?.text.toLowerCase() === 'mount') {
        for (const param of params) { const variable = param.find((part) => part.kind === 'variable'); if (variable) { add(variable, 'mount'); } }
      }
      if (isPublic && method && /^set[A-Z]/.test(method.text) && params.length === 1) {
        add(method, 'setter', method.text[3]!.toLowerCase() + method.text.slice(4));
      }
      if (method?.text.toLowerCase() === '__construct' && !readonlyClass) {
        for (const param of params) {
          const words = param.map((part) => part.text.toLowerCase());
          const variable = param.find((part) => part.kind === 'variable');
          if (variable && words.includes('public') && !words.includes('readonly') && !words.includes('set')) { add(variable, 'property'); }
        }
      }
      at = close;
      while (at + 1 < tokens.length && ![';', '{'].includes(tokens[at + 1]?.text ?? '')) { at++; }
      if (tokens[at + 1]?.text === '{') { at = paired(tokens, at + 1, '{', '}') ?? tokens.length; }
      else { at++; }
      member = [];
      continue;
    }
    if (token.text === '{') { at = paired(tokens, at, '{', '}') ?? tokens.length; member = []; continue; }
    if (token.text === ';') {
      const words = member.map((part) => part.text.toLowerCase());
      if (!readonlyClass && (words.includes('public') || words.includes('var')) &&
        !words.some((word) => ['static', 'readonly', 'private', 'protected', 'set'].includes(word))) {
        for (const entry of splitPhpParameters(member)) {
          const variable = entry.find((part) => part.kind === 'variable');
          if (variable) { add(variable, 'property'); }
        }
      }
      member = [];
    } else { member.push(token); }
  }
  return [...props.values()];
}

function splitPhpParameters(tokens: readonly PhpToken[]): PhpToken[][] {
  const result: PhpToken[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.text === ',' && depth === 0) { result.push([]); continue; }
    result.at(-1)!.push(token);
    if (['(', '[', '{', '#['].includes(token.text)) { depth++; }
    if ([')', ']', '}'].includes(token.text)) { depth--; }
  }
  return result.filter((entry) => entry.length > 0);
}
