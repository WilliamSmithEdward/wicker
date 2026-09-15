import type { OffsetRange } from '../php/templateReferences.js';
import { javascriptTokens, stringRange } from './javascript.js';
import type { FrontendReference } from './references.js';
import { stimulusOutletProperties, stimulusOutletStem, type StimulusController, type StimulusSource } from './stimulus.js';

export function resolveOutletReference(ref: FrontendReference, controllers: readonly StimulusController[]): FrontendReference | undefined {
  if (ref.kind !== 'outlet') { return undefined; }
  if (ref.controller !== undefined) { return ref; }
  const host = controllers.filter((controller) => ref.name.startsWith(`${controller.name}-`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return host ? { ...ref, controller: host.name, name: ref.name.slice(host.name.length + 1),
    range: { start: ref.range.start + host.name.length + 1, end: ref.range.end } } : undefined;
}

/**
 * The controller a template reference binds, by Stimulus' own naming rules.
 *
 * A `data-controller` names its controller outright. A value, class or outlet
 * attribute names it only as a prefix of its own name, and two identifiers can
 * both be prefixes of one attribute, so the longest wins: `user-card-url`
 * belongs to `user-card` and not to `user`.
 */
export function controllerForReference(ref: FrontendReference,
  controllers: readonly StimulusController[]): StimulusController | undefined {
  const outlet = resolveOutletReference(ref, controllers);
  const named = ref.kind === 'controller' ? ref.name : outlet?.controller ?? ref.controller;
  return controllers.filter((controller) => controller.name === named ||
    !named && ['value', 'class'].includes(ref.kind) && ref.name.startsWith(`${controller.name}-`))
    .sort((left, right) => right.name.length - left.name.length)[0];
}

export interface OutletAccess {
  readonly kind: 'declaration' | 'property' | 'method' | 'callback';
  readonly name: string;
  readonly range: OffsetRange;
  readonly outlet?: string;
}

export function outletAccessAt(source: string, info: StimulusSource, offset: number): OutletAccess | undefined {
  if (info.outletsRange && contains(info.outletsRange, offset)) {
    const token = javascriptTokens(source, info.outletsRange.start, info.outletsRange.end)
      .find((token) => token.kind === 'string' && contains(stringRange(token), offset));
    if (token) { return { kind: 'declaration', name: token.value ?? '', range: stringRange(token) }; }
  }
  const callback = info.outletCallbacks.find((member) => contains(member.range, offset));
  if (callback) {
    const outlet = info.outlets.find((member) => [`${stimulusOutletStem(member.name)}OutletConnected`,
      `${stimulusOutletStem(member.name)}OutletDisconnected`].includes(callback.name));
    if (outlet) { return { ...callback, kind: 'callback', outlet: outlet.name }; }
  }
  const access = info.accesses.find((member) => contains(member.range, offset));
  if (!access) { return undefined; }
  if (access.receiver) {
    const outlet = info.outlets.find((member) => `${stimulusOutletStem(member.name)}Outlet` === access.receiver);
    return outlet ? { ...access, kind: 'method', outlet: outlet.name } : undefined;
  }
  if (!info.outlets.length) { return undefined; }
  return { ...access, kind: 'property' };
}

export function outletUseRanges(info: StimulusSource, name: string): readonly OffsetRange[] {
  const properties = stimulusOutletProperties(name), stem = stimulusOutletStem(name);
  return [...info.accesses.filter((member) => !member.receiver && properties.includes(member.name)),
    ...info.outletCallbacks.filter((member) => [`${stem}OutletConnected`, `${stem}OutletDisconnected`].includes(member.name))]
    .map((member) => member.range);
}

function contains(range: OffsetRange, offset: number): boolean { return offset >= range.start && offset <= range.end; }
