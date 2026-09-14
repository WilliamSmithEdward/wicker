import type { OffsetRange } from '../php/templateReferences.js';
import { tokenizeTwigExpression } from '../twig/expressionLexer.js';
import { literalTwigString, splitTwigTokens } from '../twig/contextSyntax.js';
import { lexTwigRegions } from '../twig/twigLexer.js';
import { javascriptTokens, stringRange } from './javascript.js';
import type { TwigExpressionToken } from '../twig/expressionLexer.js';

export interface FrontendReference {
  readonly kind: 'controller' | 'action' | 'target' | 'value' | 'outlet' | 'class' | 'route' | 'url';
  readonly name: string;
  readonly range: OffsetRange;
  readonly controller?: string;
  readonly selector?: { readonly name: string; readonly range: OffsetRange };
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
}
const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
export const stimulusHtmlName = kebab;

/** Parses the actual Twig helpers and literal HTML attributes. Comments,
 * verbatim blocks and JS strings that resemble markup are never HTML. */
export function scanFrontend(source: string, twig: boolean): FrontendScan {
  if (!twig) { const requests = fetchReferences(source, 0, source.length); return { references: requests, requests, bindings: [], scripts: [{ start: 0, end: source.length }] }; }
  const references: FrontendReference[] = [], requests: FrontendReference[] = [], bindings: StimulusEndpointBinding[] = [], scripts: OffsetRange[] = [];
  const comments: OffsetRange[] = [...source.matchAll(/<!--[\s\S]*?(?:-->|$)/g)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const masked = source.split('');
  let verbatim = false;
  for (const region of lexTwigRegions(source)) {
    const body = source.slice(region.innerStart, region.innerEnd).trim();
    if (!verbatim && !comments.some((comment) => region.start >= comment.start && region.end <= comment.end) &&
      (region.kind === 'expression' || region.kind === 'statement')) {
      const tokens = tokenizeTwigExpression(source, region.innerStart, region.innerEnd);
      for (let i = 0; i < tokens.length; i++) {
        const helper = tokens[i]!.value;
        if (!['path', 'url', 'stimulus_controller', 'stimulus_action', 'stimulus_target'].includes(helper) ||
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
        references.push({ kind: helper === 'path' || helper === 'url' ? 'route' : 'controller', name, range: firstRange });
        const second = args[1]?.[0];
        const secondName = literalTwigString(second);
        if (second && secondName !== undefined && args[1]?.length === 1 && ['stimulus_action', 'stimulus_target'].includes(helper)) {
          addWords(references, source, second.start + 1, second.end - 1, helper === 'stimulus_action' ? 'action' : 'target', name);
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
    if (region.kind !== 'text' || verbatim) { masked.fill(' ', region.start, region.end); }
    if (region.kind === 'statement' && /^verbatim\b/.test(body)) { verbatim = true; }
    else if (region.kind === 'statement' && /^endverbatim\b/.test(body)) { verbatim = false; }
  }
  let html = masked.join('');
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
          references.push({ kind: 'controller', name: controller, range: { start: offset + from, end: offset + (hash < 0 ? text.length : hash) } });
          if (hash >= 0) {
            const action = text.slice(hash + 1).split(':')[0]!;
            references.push({ kind: 'action', controller, name: action,
              range: { start: offset + hash + 1, end: offset + hash + 1 + action.length } });
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
  return { references, requests, bindings, scripts };
}

/** Named arguments are reordered to the public helper signature. Filters have
 * the same explicit arguments: Twig supplies their implicit attributes object. */
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
  kind: FrontendReference['kind'], controller?: string): void {
  const text = source.slice(start, end);
  if (/[{}]/.test(text)) { return; }
  for (const word of text.matchAll(/[^\s]+|^$/g)) {
    result.push({ kind, name: word[0], range: { start: start + word.index, end: start + word.index + word[0].length },
      ...(controller === undefined ? {} : { controller }) });
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
