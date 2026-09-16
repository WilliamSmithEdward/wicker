import { DEFAULT_EVENTS, parseActionDescriptor } from './actionDescriptor.js';
import type { OffsetRange } from '../php/templateReferences.js';
import { tokenizeTwigExpression } from '../twig/expressionLexer.js';
import { literalTwigString, splitTwigTokens } from '../twig/contextSyntax.js';
import { lexTwigRegions } from '../twig/twigLexer.js';
import { javascriptTokens, stringRange } from './javascript.js';
import type { TwigExpressionToken } from '../twig/expressionLexer.js';

export interface FrontendReference {
  readonly kind: 'controller' | 'action' | 'target' | 'value' | 'outlet' | 'class' | 'route' | 'url'
  /** A logical asset path from `asset()`, or an importmap entrypoint from `importmap()`. */
  | 'asset' | 'entrypoint'
  /** The halves of an action descriptor that are not the controller or method. */
  | 'event' | 'keyFilter' | 'eventTarget' | 'actionOption'
  /** `data-<controller>-<name>-param`, read in a handler as `event.params.<name>`. */
  | 'actionParam'
  /** A key in the parameter hash of `path()` or `url()`. */
  | 'routeParameter';
  readonly name: string;
  readonly range: OffsetRange;
  readonly controller?: string;
  /** For a route parameter, the route whose placeholder the key fills. */
  readonly route?: string;
  readonly selector?: { readonly name: string; readonly range: OffsetRange };
  /**
   * For an action, the event named in the same descriptor.
   *
   * Carried here because an explanation of the binding needs both halves at
   * once, and the two are separate references by the time anything reads them.
   * Absent when the descriptor relies on the element's default event.
   */
  readonly event?: string;
  /**
   * The event Stimulus attaches when the descriptor names none.
   *
   * Known only where the element is: a `data-action` attribute is written on a
   * tag, while `stimulus_action()` is a call whose element nothing here can
   * see. Kept apart from `event` so that an explanation can say the event was
   * implied rather than written.
   */
  readonly defaultEvent?: string;
}
export interface StimulusEndpointBinding {
  readonly controller: string;
  readonly value: string;
  readonly endpoint: FrontendReference;
}
export interface FrontendScan {
  readonly references: readonly FrontendReference[];
  readonly requests: readonly FrontendReference[];
  readonly bindings: readonly StimulusEndpointBinding[];
  readonly scripts: readonly OffsetRange[];
  readonly routeCalls: readonly RouteCall[];
}
/** A `path()` or `url()` call with a literal route name, and what it passes. */
export interface RouteCall {
  readonly name: string;
  readonly nameRange: OffsetRange;
  /** Between the braces of a literal parameter hash, where a key can be completed. */
  readonly arguments?: OffsetRange;
  /** The keys the hash names; absent when the argument is not a literal hash, so nothing is known. */
  readonly keys?: readonly string[];
}
const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
export const stimulusHtmlName = kebab;

/** Parses the actual Twig helpers and literal HTML attributes. Comments,
 * verbatim blocks and JS strings that resemble markup are never HTML. */
export function scanFrontend(source: string, twig: boolean): FrontendScan {
  if (!twig) { const requests = fetchReferences(source, 0, source.length); return { references: requests, requests, bindings: [], scripts: [{ start: 0, end: source.length }], routeCalls: [] }; }
  const references: FrontendReference[] = [], requests: FrontendReference[] = [], bindings: StimulusEndpointBinding[] = [], scripts: OffsetRange[] = [];
  const routeCalls: RouteCall[] = [];
  const comments: OffsetRange[] = [...source.matchAll(/<!--[\s\S]*?(?:-->|$)/g)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const blanked: OffsetRange[] = [];
  let verbatim = false;
  for (const region of lexTwigRegions(source)) {
    const body = source.slice(region.innerStart, region.innerEnd).trim();
    if (!verbatim && !comments.some((comment) => region.start >= comment.start && region.end <= comment.end) &&
      (region.kind === 'expression' || region.kind === 'statement')) {
      const tokens = tokenizeTwigExpression(source, region.innerStart, region.innerEnd);
      for (let i = 0; i < tokens.length; i++) {
        const helper = tokens[i]!.value;
        if (!['path', 'url', 'asset', 'importmap', 'stimulus_controller', 'stimulus_action', 'stimulus_target'].includes(helper) ||
          tokens[i + 1]?.value !== '(' || ['.', '?.'].includes(tokens[i - 1]?.value ?? '')) { continue; }
        let end = i + 2, depth = 1;
        for (; end < tokens.length; end++) {
          if (tokens[end]!.value === '(') { depth++; }
          else if (tokens[end]!.value === ')' && --depth === 0) { break; }
        }
        const args = helperArguments(splitTwigTokens(tokens.slice(i + 2, end), ','), helper);
        const first = args[0]?.[0];
        const name = literalTwigString(first);
        if (first === undefined || name === undefined || args[0]?.length !== 1) { continue; }
        const firstRange = { start: first.start + 1, end: first.end - (source[first.end - 1] === source[first.start] ? 1 : 0) };
        const helperKind = helper === 'path' || helper === 'url' ? 'route'
          : helper === 'asset' ? 'asset' : helper === 'importmap' ? 'entrypoint' : 'controller';
        references.push({ kind: helperKind, name, range: firstRange });
        if (helperKind === 'route') { routeCalls.push(routeCall(name, firstRange, args[1], references)); i = end; continue; }
        // The remaining arguments belong to the Stimulus helpers only.
        if (helper === 'asset' || helper === 'importmap') { i = end; continue; }
        const second = args[1]?.[0];
        const secondName = literalTwigString(second);
        if (second && secondName !== undefined && args[1]?.length === 1 && ['stimulus_action', 'stimulus_target'].includes(helper)) {
          // The helper spells the event as its own argument rather than inside
          // a descriptor, so it is picked up here instead.
          const eventName = helper === 'stimulus_action' ? literalTwigString(args[2]?.[0]) : undefined;
          addWords(references, source, second.start + 1, second.end - 1,
            helper === 'stimulus_action' ? 'action' : 'target', name, eventName);
        }
        if (helper === 'stimulus_controller' && second?.value === '{') {
          for (const entry of splitTwigTokens(args[1]!.slice(1, args[1]!.at(-1)?.value === '}' ? -1 : undefined), ',')) {
            const key = entry[0];
            const value = key?.kind === 'name' ? key.value : literalTwigString(key);
            if (!key || value === undefined || entry[1]?.value !== ':') { continue; }
            references.push({ kind: 'value', controller: name, name: value,
              range: key.kind === 'string' ? { start: key.start + 1, end: key.end - 1 } : key });
            const routeName = literalTwigString(entry[4]);
            if (['path', 'url'].includes(entry[2]?.value ?? '') && entry[3]?.value === '(' && routeName !== undefined &&
              [')', ','].includes(entry[5]?.value ?? '')) {
              bindings.push({ controller: name, value, endpoint: { kind: 'route', name: routeName,
                range: { start: entry[4]!.start + 1, end: entry[4]!.end - 1 } } });
            }
          }
        }
        // The third argument maps a logical class name to the CSS classes it
        // stands for. Only the key is a declaration; the value is ordinary CSS
        // and belongs to the stylesheet, not to Stimulus.
        const classMap = args[2];
        if (helper === 'stimulus_controller' && classMap?.[0]?.value === '{') {
          for (const entry of splitTwigTokens(classMap.slice(1, classMap.at(-1)?.value === '}' ? -1 : undefined), ',')) {
            const key = entry[0];
            const logical = key?.kind === 'name' ? key.value : literalTwigString(key);
            if (!key || logical === undefined || entry[1]?.value !== ':') { continue; }
            references.push({ kind: 'class', controller: name, name: logical,
              range: key.kind === 'string' ? { start: key.start + 1, end: key.end - 1 } : key });
          }
        }
        const outletMap = args[3];
        if (helper === 'stimulus_controller' && outletMap?.[0]?.value === '{') {
          for (const entry of splitTwigTokens(outletMap.slice(1, outletMap.at(-1)?.value === '}' ? -1 : undefined), ',')) {
            const key = entry[0], selector = entry[2];
            const outlet = key?.kind === 'name' ? key.value : literalTwigString(key);
            if (!key || outlet === undefined || entry[1]?.value !== ':') { continue; }
            const selectorName = entry.length === 3 ? literalTwigString(selector) : undefined;
            references.push({ kind: 'outlet', name: outlet, controller: name,
              range: key.kind === 'string' ? { start: key.start + 1, end: key.end - 1 } : key,
              ...(selector && selectorName !== undefined ? { selector: { name: selectorName, range: { start: selector.start + 1, end: selector.end - 1 } } } : {}) });
          }
        }
      }
    }
    if (region.kind !== 'text' || verbatim) { blanked.push({ start: region.start, end: region.end }); }
    if (region.kind === 'statement' && /^verbatim\b/.test(body)) { verbatim = true; }
    else if (region.kind === 'statement' && /^endverbatim\b/.test(body)) { verbatim = false; }
  }
  /*
   * The Twig blanked out, so what is left is the HTML alone and every offset
   * still lines up with the source.
   *
   * Assembled from slices rather than by holding one string per source
   * character: that array cost half a millisecond of pure allocation on a
   * 50 KB template, paid for every file the index scans and again for every
   * document parsed without a cached scan. The regions arrive in order and do
   * not overlap, and the clamp keeps it correct if that ever stops being true.
   */
  const pieces: string[] = [];
  let mask = 0;
  for (const region of blanked) {
    if (region.end <= mask) { continue; }
    const start = Math.max(mask, region.start);
    pieces.push(source.slice(mask, start), ' '.repeat(region.end - start));
    mask = region.end;
  }
  pieces.push(source.slice(mask));
  let html = pieces.join('');
  html = html.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => ' '.repeat(comment.length));
  const tag = /<([a-z][\w:-]*)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html))) {
    let end = tag.lastIndex, quote = '';
    for (; end < html.length; end++) {
      const char = html[end]!;
      if (quote) { if (char === quote) { quote = ''; } }
      else if (char === '"' || char === "'") { quote = char; }
      else if (char === '>') { break; }
    }
    const attrs = html.slice(tag.lastIndex, end);
    const attribute = /([^\s=<>]+)\s*=\s*(["'])([\s\S]*?)(?:\2|$)/g;
    let attr: RegExpExecArray | null;
    while ((attr = attribute.exec(attrs))) {
      const attrName = attr[1]!;
      const attrStart = tag.lastIndex + attr.index;
      const start = attrStart + attr[0].indexOf(attr[2]!) + 1;
      const stop = start + attr[3]!.length;
      if (attrName === 'data-controller') { addWords(references, source, start, stop, 'controller'); }
      else if (attrName === 'data-action') {
        for (const word of source.slice(start, stop).matchAll(/\S+|^$/g)) {
          const text = word[0];
          if (text.includes('{')) { continue; }
          const offset = start + word.index;
          const from = text.includes('->') ? text.indexOf('->') + 2 : 0;
          const hash = text.indexOf('#', from);
          const controller = text.slice(from, hash < 0 ? undefined : hash);
          // The halves that are not the controller or method. Pushed first so
          // the method stays last, which is where an empty name marks the
          // editing position. None of these ranges overlap.
          const descriptor = parseActionDescriptor(text, offset);
          if (descriptor.event) { references.push({ kind: 'event', ...descriptor.event }); }
          if (descriptor.keyFilter) { references.push({ kind: 'keyFilter', ...descriptor.keyFilter }); }
          if (descriptor.eventTarget) { references.push({ kind: 'eventTarget', ...descriptor.eventTarget }); }
          for (const option of descriptor.options) { references.push({ kind: 'actionOption', ...option }); }

          references.push({ kind: 'controller', name: controller, range: { start: offset + from, end: offset + (hash < 0 ? text.length : hash) } });
          if (hash >= 0) {
            const action = text.slice(hash + 1).split(':')[0]!;
            const implied = DEFAULT_EVENTS[match[1]!.toLowerCase()];
            references.push({ kind: 'action', controller, name: action,
              range: { start: offset + hash + 1, end: offset + hash + 1 + action.length },
              ...(descriptor.event && descriptor.event.name ? { event: descriptor.event.name }
                : implied === undefined ? {} : { defaultEvent: implied }) });
          }
        }
      } else if (attrName.startsWith('data-') && attrName.endsWith('-target')) {
        const controller = attrName.slice(5, -7);
        references.push({ kind: 'controller', name: controller, range: { start: attrStart + 5, end: attrStart + attrName.length - 7 } });
        addWords(references, source, start, stop, 'target', controller);
      } else if (attrName.startsWith('data-') && attrName.endsWith('-outlet')) {
        const raw = source.slice(start, stop);
        references.push({ kind: 'outlet', name: attrName.slice(5, -7),
          range: { start: attrStart + 5, end: attrStart + attrName.length - 7 },
          ...(!/[{}]/.test(raw) ? { selector: { name: raw, range: { start, end: stop } } } : {}) });
      } else if (attrName.startsWith('data-') && attrName.endsWith('-param')) {
        // No declaration exists for these. Stimulus collects them onto
        // event.params, so the name is invented in the template and read in
        // the handler, with nothing connecting the two.
        const combined = attrName.slice(5, -6);
        references.push({ kind: 'actionParam', name: combined, range: { start: attrStart + 5, end: attrStart + attrName.length - 6 } });
      } else if (attrName.startsWith('data-') && attrName.endsWith('-class')) {
        // Same shape as a value attribute: the controller name may itself
        // contain dashes, so the combined name is kept and the longest
        // registered prefix is resolved later.
        const combined = attrName.slice(5, -6);
        references.push({ kind: 'class', name: combined, range: { start: attrStart + 5, end: attrStart + attrName.length - 6 } });
      } else if (attrName.startsWith('data-') && attrName.endsWith('-value')) {
        // Controller names themselves contain dashes. Resolve the longest registered
        // prefix later; keep this attribute's combined name until then.
        const combined = attrName.slice(5, -6);
        references.push({ kind: 'value', name: combined, range: { start: attrStart + 5, end: attrStart + attrName.length - 6 } });
        const route = references.find((ref) => ref.kind === 'route' && ref.range.start >= start && ref.range.end <= stop);
        const raw = source.slice(start, stop);
        if (route || /^\/(?!\/)[^{}\s]*$/.test(raw)) {
          bindings.push({ controller: '', value: combined, endpoint: route ?? { kind: 'url', name: raw, range: { start, end: stop } } });
        }
      }
    }
    tag.lastIndex = end + 1;
    if (['script', 'style'].includes(match[1]!.toLowerCase())) {
      const closing = new RegExp(`</${match[1]}\\s*>`, 'gi');
      closing.lastIndex = tag.lastIndex;
      const finish = closing.exec(html);
      const stop = finish?.index ?? html.length;
      if (match[1]!.toLowerCase() === 'script') {
        scripts.push({ start: tag.lastIndex, end: stop });
        const calls = fetchReferences(source, tag.lastIndex, stop, references);
        requests.push(...calls);
        references.push(...calls.filter((call) => call.kind === 'url'));
      }
      tag.lastIndex = finish ? closing.lastIndex : html.length;
    }
  }
  return { references, requests, bindings, scripts, routeCalls };
}

/** Named arguments are reordered to the public helper signature. Filters have
 * the same explicit arguments: Twig supplies their implicit attributes object. */
/**
 * What a route call passes, when that can be read.
 *
 * Only a literal hash says which keys it has: a variable, or a hash with a
 * filter applied, could hold anything, and a call with no second argument
 * passes nothing. An unclosed hash is still being typed and counts to its end.
 */
function routeCall(name: string, nameRange: OffsetRange, argument: readonly TwigExpressionToken[] | undefined,
  references: FrontendReference[]): RouteCall {
  const open = argument?.[0];
  if (argument === undefined || open === undefined) { return { name, nameRange, keys: [] }; }
  if (open.value !== '{') { return { name, nameRange }; }
  let depth = 0, close: number | undefined;
  for (let index = 0; index < argument.length; index++) {
    const value = argument[index]!.value;
    if (value === '{' || value === '[' || value === '(') { depth++; }
    else if ((value === '}' || value === ']' || value === ')') && --depth === 0) { close = index; break; }
  }
  if (close !== undefined && close !== argument.length - 1) { return { name, nameRange }; }
  const keys: string[] = [];
  for (const entry of splitTwigTokens(argument.slice(1, close), ',')) {
    const key = entry[0];
    const value = key?.kind === 'name' ? key.value : literalTwigString(key);
    if (!key || value === undefined || entry[1]?.value !== ':') { continue; }
    keys.push(value);
    references.push({ kind: 'routeParameter', name: value, route: name,
      range: key.kind === 'string' ? { start: key.start + 1, end: key.end - 1 } : { start: key.start, end: key.end } });
  }
  const last = argument[close ?? argument.length - 1]!;
  return { name, nameRange, keys, arguments: { start: open.end, end: close === undefined ? last.end : last.start } };
}

function helperArguments(args: readonly (readonly TwigExpressionToken[])[], helper: string): readonly (readonly TwigExpressionToken[])[] {
  const names = helper === 'stimulus_controller' ? ['controllerName', 'controllerValues', 'controllerClasses', 'controllerOutlets']
    : helper === 'stimulus_action' ? ['controllerName', 'actionName', 'eventName', 'parameters']
      : helper === 'stimulus_target' ? ['controllerName', 'targetNames'] : ['name', 'parameters', 'relative'];
  const result: (readonly TwigExpressionToken[])[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg[0]?.kind === 'name' && [':', '='].includes(arg[1]?.value ?? '')) {
      const index = names.indexOf(arg[0].value);
      if (index >= 0) { result[index] = arg.slice(2); }
    } else { result[i] = arg; }
  }
  return result;
}

function addWords(result: FrontendReference[], source: string, start: number, end: number,
  kind: FrontendReference['kind'], controller?: string, event?: string): void {
  const text = source.slice(start, end);
  if (/[{}]/.test(text)) { return; }
  const extra = { ...(controller === undefined ? {} : { controller }), ...(event === undefined ? {} : { event }) };
  for (const word of text.matchAll(/[^\s]+|^$/g)) {
    result.push({ kind, name: word[0], range: { start: start + word.index, end: start + word.index + word[0].length }, ...extra });
  }
  // A space after an existing item starts another controller or target.
  if (/\s$/.test(text)) { result.push({ kind, name: '', range: { start: end, end }, ...(controller === undefined ? {} : { controller }) }); }
}

function fetchReferences(source: string, start: number, end: number, twigReferences: readonly FrontendReference[] = []): FrontendReference[] {
  const tokens = javascriptTokens(source, start, end);
  return tokens.flatMap((token, i): FrontendReference[] => {
    const arg = tokens[i + 2];
    if (token.text !== 'fetch' || tokens[i + 1]?.text !== '(' || arg?.kind !== 'string' ||
      ![')', ','].includes(tokens[i + 3]?.text ?? '') ||
      ['.', '?.'].includes(tokens[i - 1]?.text ?? '') && !['window', 'globalThis'].includes(tokens[i - 2]?.text ?? '')) { return []; }
    if (arg.value?.startsWith('/') && !arg.value.startsWith('//')) { return [{ kind: 'url', name: arg.value, range: stringRange(arg) }]; }
    if (/^\{\{\s*(?:path|url)\([\s\S]*\)\s*\}\}$/.test(arg.value ?? '')) {
      const matches = twigReferences.filter((ref) => ref.kind === 'route' && ref.range.start > arg.start && ref.range.end < arg.end);
      if (matches.length === 1) { return matches; }
    }
    return [];
  });
}
