import type { OffsetRange } from '../php/templateReferences.js';
import { closingToken, javascriptTokens, stringRange } from './javascript.js';

export interface StimulusMember { readonly name: string; readonly range: OffsetRange }
export interface StimulusSource {
  readonly range: OffsetRange;
  readonly actions: readonly StimulusMember[];
  readonly targets: readonly StimulusMember[];
  readonly values: readonly StimulusMember[];
}
export interface StimulusController { readonly name: string; readonly projectPath: string }

export function stimulusIdentifier(relativePath: string): string | undefined {
  if (!/[-_]controller\.[jt]s$/.test(relativePath)) { return undefined; }
  return relativePath.replace(/[-_]controller\.[jt]s$/, '').replaceAll('_', '-').replaceAll('/', '--');
}

/** Direct members of the default exported class only. Inheritance, computed
 * declarations and runtime registrations deliberately remain unknown. */
export function stimulusSource(source: string): StimulusSource {
  const tokens = javascriptTokens(source);
  const empty = { range: { start: 0, end: 0 }, actions: [], targets: [], values: [] };
  const exported = tokens.findIndex((t, i) => t.text === 'export' && tokens[i + 1]?.text === 'default');
  if (exported < 0) { return empty; }
  let klass = exported + 2;
  if (tokens[klass]?.text !== 'class') {
    const name = tokens[klass]?.text;
    klass = tokens.findIndex((t, i) => t.text === 'class' && tokens[i + 1]?.text === name);
  }
  if (klass < 0 || tokens[klass]?.text !== 'class') { return empty; }
  const open = tokens.findIndex((t, i) => i > klass && t.text === '{');
  const close = closingToken(tokens, open);
  if (close < 0) { return empty; }
  const actions: StimulusMember[] = [], targets: StimulusMember[] = [], values: StimulusMember[] = [];
  const lifecycle = new Set(['constructor', 'initialize', 'connect', 'disconnect']);
  for (let i = open + 1; i < close; i++) {
    const t = tokens[i]!;
    if (t.text === 'static' && ['targets', 'values'].includes(tokens[i + 1]?.text ?? '') && tokens[i + 2]?.text === '=') {
      const kind = tokens[i + 1]!.text;
      const from = i + 3, end = closingToken(tokens, from);
      if (end < 0) { continue; }
      for (let j = from + 1; j < end; j++) {
        const member = tokens[j]!;
        if (kind === 'targets' && member.kind === 'string' && ['[', ','].includes(tokens[j - 1]?.text ?? '') &&
          [',', ']'].includes(tokens[j + 1]?.text ?? '') && member.value) {
          targets.push({ name: member.value, range: stringRange(member) });
        }
        if (kind === 'values' && ['name', 'string'].includes(member.kind) && tokens[j + 1]?.text === ':' &&
          ['{', ','].includes(tokens[j - 1]?.text ?? '')) {
          values.push({ name: member.value ?? member.text, range: member.kind === 'string' ? stringRange(member) : member });
        }
        if (['{', '[', '('].includes(member.text)) { const nested = closingToken(tokens, j); if (nested >= 0) { j = nested; } }
      }
      i = end;
      continue;
    }
    if (t.kind === 'name' && tokens[i + 1]?.text === '(') {
      const args = closingToken(tokens, i + 1);
      let body = args + 1;
      // Return type annotations may precede a method body.
      if (tokens[body]?.text === ':') { while (body < close && !['{', ';', '='].includes(tokens[body]?.text ?? '')) { body++; } }
      if (args >= 0 && tokens[body]?.text === '{') {
        const modifiers: string[] = [];
        for (let j = i - 1; j > open && ![';', '}', '{'].includes(tokens[j]!.text); j--) { modifiers.push(tokens[j]!.text); }
        if (!lifecycle.has(t.text) && !/(?:TargetConnected|TargetDisconnected|ValueChanged)$/.test(t.text) &&
          !modifiers.some((m) => ['#', 'private', 'protected', 'static', 'get', 'set', '='].includes(m))) {
          actions.push({ name: t.text, range: t });
        }
        const end = closingToken(tokens, body);
        if (end >= 0) { i = end; }
        continue;
      }
    }
    if (['{', '[', '('].includes(t.text)) { const end = closingToken(tokens, i); if (end >= 0) { i = end; } }
  }
  return { range: tokens[klass]!, actions, targets, values };
}
