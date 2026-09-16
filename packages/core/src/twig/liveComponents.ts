import { tokenizePhp, type PhpToken } from '../php/lexer.js';
import type { OffsetRange } from '../php/templateReferences.js';
import { rememberLast } from '../util/rememberLast.js';

/** A property or method a live component exposes to its template. */
export interface LiveMember {
  readonly name: string;
  readonly range: OffsetRange;
  /** For a prop, whether `writable: true` lets the template change it. */
  readonly writable?: boolean;
}

/** What a live component class declares: props a template can bind, actions it can call. */
export interface LiveComponentSource {
  readonly props: readonly LiveMember[];
  readonly actions: readonly LiveMember[];
}

/** A binding in a live component's template: `data-model` to a prop, or an action by name. */
export interface LiveReference {
  readonly kind: 'model' | 'action';
  readonly name: string;
  readonly range: OffsetRange;
}

/**
 * Reads `#[LiveProp]` properties and `#[LiveAction]` methods from a class.
 *
 * The attribute decides what a template may reach: `data-model` binds only a
 * prop marked writable, and `live_action()` calls only a method so marked.
 * Neither fact is visible from the template, and a name that misses gets a
 * request that is refused rather than an error in the editor.
 */
export const liveComponentSource = rememberLast(parseSource);

/**
 * The bindings a template writes, with the name's own range.
 *
 * `data-model` may carry modifiers, `on(change)|debounce(300)|title`, and a
 * path into the prop, `form.title`; the prop is the first segment after the
 * last modifier. Values holding Twig are left alone: they name nothing that
 * can be read here.
 */
export const liveReferences = rememberLast(parseReferences);

function parseSource(source: string): LiveComponentSource {
  const props: LiveMember[] = [], actions: LiveMember[] = [];
  if (source.length > 512 * 1024) { return { props, actions }; }
  const tokens = tokenizePhp(source).filter((token) => token.kind !== 'comment');
  for (let at = 0; at < tokens.length; at++) {
    if (tokens[at]!.kind !== 'attribute-open') { continue; }
    const close = paired(tokens, at);
    if (close === undefined) { break; }
    const attributes = attributesIn(tokens.slice(at + 1, close));
    const member = memberAfter(tokens, close + 1);
    if (member === undefined) { continue; }
    for (const attribute of attributes) {
      if (attribute.name === 'LiveProp' && member.kind === 'property' && !props.some((entry) => entry.name === member.name)) {
        props.push({ name: member.name, range: member.range, writable: attribute.writable });
      } else if (attribute.name === 'LiveAction' && member.kind === 'method' && !actions.some((entry) => entry.name === member.name)) {
        actions.push({ name: member.name, range: member.range });
      }
    }
  }
  return { props, actions };
}

/** Each attribute in one `#[...]` group, by its last name segment, with whether it says `writable`. */
function attributesIn(tokens: readonly PhpToken[]): { name: string; writable: boolean }[] {
  const found: { name: string; writable: boolean }[] = [];
  for (let at = 0; at < tokens.length; at++) {
    if (tokens[at]!.kind !== 'identifier') { continue; }
    let name = tokens[at]!.text;
    while (tokens[at + 1]?.text === '\\' && tokens[at + 2]?.kind === 'identifier') { name = tokens[at + 2]!.text; at += 2; }
    let writable = false;
    if (tokens[at + 1]?.text === '(') {
      const close = paired(tokens, at + 1, '(', ')');
      if (close === undefined) { break; }
      const args = tokens.slice(at + 2, close);
      writable = args.some((token, index) => token.text === 'writable' && args[index + 1]?.text === ':' &&
        args[index + 2]?.text.toLowerCase() !== 'false');
      at = close;
    }
    found.push({ name: name.split('\\').at(-1) ?? name, writable });
    while (at + 1 < tokens.length && tokens[at + 1]?.text !== ',') { at++; }
  }
  return found;
}

/** The property or method the attributes above it decorate, past any further attribute groups and modifiers. */
function memberAfter(tokens: readonly PhpToken[], from: number):
{ kind: 'property' | 'method'; name: string; range: OffsetRange } | undefined {
  for (let at = from; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token.kind === 'attribute-open') {
      const close = paired(tokens, at);
      if (close === undefined) { return undefined; }
      at = close;
    } else if (token.kind === 'variable') {
      return { kind: 'property', name: token.text.slice(1), range: { start: token.start + 1, end: token.end } };
    } else if (token.kind === 'identifier' && token.text.toLowerCase() === 'function') {
      const name = tokens[at + 1];
      return name?.kind === 'identifier' ? { kind: 'method', name: name.text, range: { start: name.start, end: name.end } } : undefined;
    } else if (['{', '}', ';', '('].includes(token.text) || (token.kind === 'identifier' && token.text.toLowerCase() === 'class')) {
      return undefined;
    }
  }
  return undefined;
}

function paired(tokens: readonly PhpToken[], at: number, open = '[', close = ']'): number | undefined {
  let depth = 0;
  for (let index = at; index < tokens.length; index++) {
    const text = tokens[index]!.text;
    if (text === open || (open === '[' && tokens[index]!.kind === 'attribute-open')) { depth++; }
    else if (text === close && --depth === 0) { return index; }
  }
  return undefined;
}

const NAME = /^[A-Za-z_][\w]*/;

function parseReferences(source: string): readonly LiveReference[] {
  const references: LiveReference[] = [];
  const attribute = (pattern: RegExp, kind: LiveReference['kind']): void => {
    for (const match of source.matchAll(pattern)) {
      const value = match[2] ?? '';
      if (/[{}]/.test(value)) { continue; }
      // The value sits just before the closing quote, which ends the match.
      const valueStart = match.index + match[0].length - 1 - value.length;
      const nameStart = value.lastIndexOf('|') + 1;
      const name = NAME.exec(value.slice(nameStart))?.[0];
      if (name === undefined) { continue; }
      references.push({ kind, name, range: { start: valueStart + nameStart, end: valueStart + nameStart + name.length } });
    }
  };
  attribute(/\bdata-model\s*=\s*(["'])([^"']*)\1/g, 'model');
  attribute(/\bdata-live-action-param\s*=\s*(["'])([^"']*)\1/g, 'action');
  attribute(/\blive_action\(\s*(["'])([^"']*)\1/g, 'action');
  return references.sort((left, right) => left.range.start - right.range.start);
}
