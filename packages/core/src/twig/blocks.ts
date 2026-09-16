import type { OffsetRange } from '../php/templateReferences.js';
import { rememberLast } from '../util/rememberLast.js';
import { tokenizeTwigExpression } from './expressionLexer.js';
import { lexTwigRegions } from './twigLexer.js';

/** A `{% block %}` a template declares. */
export interface TwigBlock {
  readonly name: string;
  readonly nameRange: OffsetRange;
  /** From the opening tag to the end of its `endblock`, or of the tag alone in the inline form. */
  readonly range: OffsetRange;
  /** How many blocks enclose this one. */
  readonly depth: number;
  /** The template an enclosing `{% embed %}` names, when the block sits inside one; empty when that name is not literal. */
  readonly embed?: string;
}

/** An `{% embed %}` and the template it takes its blocks from. */
export interface TwigEmbed {
  /** Empty when the template is named at runtime. */
  readonly template: string;
  /** From the opening tag to the end of `endembed`, or of the source when it is still open. */
  readonly range: OffsetRange;
}

interface Structure { readonly blocks: readonly TwigBlock[]; readonly embeds: readonly TwigEmbed[] }
type Frame =
  | { readonly kind: 'block'; readonly name: string; readonly nameRange: OffsetRange; readonly start: number; readonly depth: number; readonly embed?: string }
  | { readonly kind: 'embed'; readonly template: string; readonly start: number };

const structure = rememberLast(parse);

/**
 * The blocks a template declares, in source order.
 *
 * Nesting is kept, because a child may override a nested block as well as
 * the one around it, and a block inside `{% embed %}` belongs to the embedded
 * template's chain rather than this one's. An unclosed block runs to the end
 * of the source, since a template is unclosed for most of the time it is
 * being typed. `{% verbatim %}` is skipped: what it holds is text.
 */
export function twigBlocks(source: string): readonly TwigBlock[] { return structure(source).blocks; }

export function twigEmbeds(source: string): readonly TwigEmbed[] { return structure(source).embeds; }

function parse(source: string): Structure {
  const blocks: TwigBlock[] = [];
  const embeds: TwigEmbed[] = [];
  const frames: Frame[] = [];
  let verbatim = false;
  for (const region of lexTwigRegions(source)) {
    if (region.kind !== 'statement') { continue; }
    const tokens = tokenizeTwigExpression(source, region.innerStart, region.innerEnd);
    const tag = tokens[0];
    if (tag?.kind !== 'name') { continue; }
    if (tag.value === 'verbatim') { verbatim = true; continue; }
    if (tag.value === 'endverbatim') { verbatim = false; continue; }
    if (verbatim) { continue; }

    if (tag.value === 'block') {
      const name = tokens[1];
      if (name?.kind !== 'name') { continue; }
      let embed: string | undefined;
      let depth = 0;
      for (const frame of frames) {
        if (frame.kind === 'embed') { embed = frame.template; } else { depth += 1; }
      }
      const block = { name: name.value, nameRange: { start: name.start, end: name.end }, depth, ...(embed === undefined ? {} : { embed }) };
      // The inline form carries its content in the tag and has no endblock.
      if (tokens.length > 2) { blocks.push({ ...block, range: { start: region.start, end: region.end } }); }
      else { frames.push({ kind: 'block', ...block, start: region.start }); }
    } else if (tag.value === 'endblock') {
      const index = lastIndex(frames, 'block');
      if (index === -1) { continue; }
      const [frame] = frames.splice(index, 1) as [Extract<Frame, { kind: 'block' }>];
      blocks.push(closed(frame, region.end));
    } else if (tag.value === 'embed') {
      const name = tokens[1];
      frames.push({ kind: 'embed', template: name?.kind === 'string' ? name.value.slice(1, -1) : '', start: region.start });
    } else if (tag.value === 'endembed') {
      const index = lastIndex(frames, 'embed');
      if (index === -1) { continue; }
      const [frame] = frames.splice(index, 1) as [Extract<Frame, { kind: 'embed' }>];
      embeds.push({ template: frame.template, range: { start: frame.start, end: region.end } });
    }
  }
  for (const frame of frames) {
    if (frame.kind === 'block') { blocks.push(closed(frame, source.length)); }
    else { embeds.push({ template: frame.template, range: { start: frame.start, end: source.length } }); }
  }
  blocks.sort((left, right) => left.range.start - right.range.start);
  embeds.sort((left, right) => left.range.start - right.range.start);
  return { blocks, embeds };
}

function closed(frame: Extract<Frame, { kind: 'block' }>, end: number): TwigBlock {
  const { name, nameRange, depth, embed, start } = frame;
  return { name, nameRange, depth, range: { start, end }, ...(embed === undefined ? {} : { embed }) };
}

function lastIndex(frames: readonly Frame[], kind: Frame['kind']): number {
  for (let index = frames.length - 1; index >= 0; index--) {
    if (frames[index]!.kind === kind) { return index; }
  }
  return -1;
}
