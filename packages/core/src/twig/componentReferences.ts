import type { OffsetRange } from '../php/templateReferences.js';

import { literalTwigString } from './contextSyntax.js';
import { scanTwigCallables } from './callables.js';
import { tokenizeTwigExpression } from './expressionLexer.js';
import { lexTwigRegions } from './twigLexer.js';

export interface ComponentReference {
  readonly name: string;
  readonly range: OffsetRange;
  readonly kind: 'name' | 'prop';
  readonly prop?: string;
  readonly usedProps?: readonly string[];
  readonly hasValue?: boolean;
}

/** HTML-like component tags plus literal component() and component tag names. */
export function componentReferenceAt(source: string, offset: number): ComponentReference | undefined {
  if (source.length > 512 * 1024) { return undefined; }
  const regions = lexTwigRegions(source);
  const masked: string[] = [];
  let verbatim = false;
  let blockedOffset = false;
  for (const region of regions) {
    const text = source.slice(region.start, region.end);
    const tokens = region.kind === 'statement' || region.kind === 'expression'
      ? tokenizeTwigExpression(source, region.innerStart, region.innerEnd) : [];
    const tag = region.kind === 'statement' ? tokens[0]?.value : undefined;
    if (offset >= region.start && offset < region.end && (verbatim || region.kind !== 'text')) { blockedOffset = true; }
    if (tag === 'endverbatim') { verbatim = false; masked.push(' '.repeat(text.length)); continue; }
    if (verbatim) { masked.push(' '.repeat(text.length)); continue; }
    if (tag === 'verbatim') { verbatim = true; masked.push(' '.repeat(text.length)); continue; }
    if (offset >= region.start && offset <= region.end && tokens.length > 0) {
      for (let at = 0; at < tokens.length; at++) {
        if (tokens[at]?.value !== 'component') { continue; }
        const functionCall = tokens[at + 1]?.value === '(' && !['.', '?.', '|'].includes(tokens[at - 1]?.value ?? '');
        if (functionCall && !scanTwigCallables(source).some((call) => call.kind === 'function' && call.range.start === tokens[at]?.start)) { continue; }
        let nameAt = at + (functionCall ? 2 : 1);
        if (!functionCall && !(at === 0 && tag === 'component')) { continue; }
        if (functionCall && tokens[nameAt]?.value === 'name' && [':', '='].includes(tokens[nameAt + 1]?.value ?? '')) { nameAt += 2; }
        const token = tokens[nameAt];
        if (token?.kind !== 'string' || !['"', "'"].includes(token.value[0] ?? '')) { continue; }
        const next = tokens[nameAt + 1]?.value;
        if (next !== undefined && !(functionCall ? [',', ')'] : ['with']).includes(next)) { continue; }
        const closed = token.value.length > 1 && token.value.endsWith(token.value[0]!);
        const range = { start: token.start + 1, end: token.end - (closed ? 1 : 0) };
        const name = closed ? literalTwigString(token) : token.value.slice(1);
        if (name !== undefined && !name.includes('#{') && offset >= range.start && offset <= range.end) {
          return { name, range, kind: 'name' };
        }
      }
    }
    masked.push(region.kind === 'text' ? text : ' '.repeat(text.length));
  }
  if (blockedOffset) { return undefined; }
  // Masking preserves offsets while keeping comments, expressions and verbatim
  // out of HTML matching. Attribute values still have their surrounding quotes.
  const html = masked.join('');
  for (let at = 0; at < html.length; at++) {
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4); at = end < 0 ? html.length : end + 2; continue;
    }
    if (html[at] !== '<') { continue; }
    let cursor = at + 1;
    const closing = html[cursor] === '/';
    if (closing) { cursor++; }
    const tagStart = cursor;
    while (/[\w:.-]/.test(html[cursor] ?? '') && cursor < html.length) { cursor++; }
    const tag = html.slice(tagStart, cursor);
    if (tag.length === 0) { continue; }
    const component = tag.startsWith('twig:') && !['twig:block', 'twig:component'].includes(tag);
    const name = tag.slice(5);
    const nameRange = { start: tagStart + 5, end: cursor };
    if (component && offset >= nameRange.start && offset <= nameRange.end) { return { name, range: nameRange, kind: 'name' }; }
    const attributes: { name: string; range: OffsetRange; hasValue: boolean }[] = [];
    let selected: ComponentReference | undefined;
    while (cursor < html.length && html[cursor] !== '>' && html[cursor] !== '<') {
      const spaceStart = cursor;
      while (/\s/.test(html[cursor] ?? '') && cursor < html.length) { cursor++; }
      if (component && !closing && offset > spaceStart && offset <= cursor) {
        selected = { name, range: { start: offset, end: offset }, kind: 'prop', prop: '', hasValue: false };
      }
      if (['>', '/', '<', undefined].includes(html[cursor])) { if (html[cursor] === '/') { cursor++; } else { break; } continue; }
      if (html[cursor] === ':') { cursor++; }
      const start = cursor;
      while (/[\w:.-]/.test(html[cursor] ?? '') && cursor < html.length) { cursor++; }
      if (cursor === start) { cursor++; continue; }
      const prop = html.slice(start, cursor);
      const range = { start, end: cursor };
      while (/\s/.test(html[cursor] ?? '') && cursor < html.length) { cursor++; }
      const hasValue = html[cursor] === '=';
      attributes.push({ name: prop, range, hasValue });
      if (component && !closing && offset >= start && offset <= range.end) {
        selected = { name, range, kind: 'prop', prop, hasValue };
      }
      if (!hasValue) { continue; }
      cursor++;
      while (/\s/.test(html[cursor] ?? '') && cursor < html.length) { cursor++; }
      const quote = html[cursor];
      if (quote === '"' || quote === "'") {
        cursor++;
        while (cursor < html.length && html[cursor] !== quote) { cursor++; }
        if (cursor < html.length) { cursor++; }
      } else {
        while (cursor < html.length && !/[\s>]/.test(html[cursor]!)) { cursor++; }
      }
    }
    if (selected) {
      return { ...selected, usedProps: attributes.filter((attr) => attr.range.start !== selected.range.start).map((attr) => attr.name) };
    }
    at = html[cursor] === '<' ? cursor - 1 : cursor;
    if (!closing && ['script', 'style'].includes(tag.toLowerCase())) {
      const end = html.toLowerCase().indexOf(`</${tag.toLowerCase()}`, at);
      at = end < 0 ? html.length : end - 1;
    }
  }
  return undefined;
}
