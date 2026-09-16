import { describe, expect, it } from 'vitest';
import { liveComponentSource, liveReferences } from './liveComponents.js';

describe('liveComponentSource', () => {
  const source = `<?php
namespace App\\Twig\\Components;
use Symfony\\UX\\LiveComponent\\Attribute\\AsLiveComponent;
use Symfony\\UX\\LiveComponent\\Attribute\\LiveAction;
use Symfony\\UX\\LiveComponent\\Attribute\\LiveProp;

#[AsLiveComponent('Counter')]
final class Counter
{
    #[LiveProp(writable: true)]
    public int $count = 0;
    #[LiveProp]
    #[\\Symfony\\Component\\Validator\\Constraints\\NotBlank]
    public string $label = '';
    #[LiveProp(writable: ['title']), \\Other\\Attr(1)]
    public array $form = [];
    public function __construct(#[LiveProp(writable: false)] public string $id = '') {}
    // #[LiveAction] in a comment is not one.
    #[LiveAction]
    public function increment(): void { $this->count++; }
    public function helper(): void {}
}`;

  it('reads props with whether the template may write them, and actions', () => {
    const live = liveComponentSource(source);
    expect(live.props.map((prop) => [prop.name, prop.writable])).toEqual([['count', true], ['label', false], ['form', true], ['id', false]]);
    expect(live.actions.map((action) => action.name)).toEqual(['increment']);
    const count = live.props[0]!;
    expect(source.slice(count.range.start, count.range.end)).toBe('count');
    const increment = live.actions[0]!;
    expect(source.slice(increment.range.start, increment.range.end)).toBe('increment');
  });
});

describe('liveReferences', () => {
  it('finds data-model bindings past their modifiers, and actions by name', () => {
    const template = `<div {{ attributes }}>
  <input data-model="count">
  <input data-model="on(change)|debounce(300)|form.title">
  <input data-model="{{ dynamic }}">
  <button {{ live_action('increment') }}>+</button>
  <button data-action="live#action" data-live-action-param='reset'>0</button>
</div>`;
    const found = liveReferences(template);
    expect(found.map((ref) => [ref.kind, ref.name, template.slice(ref.range.start, ref.range.end)])).toEqual([
      ['model', 'count', 'count'], ['model', 'form', 'form'], ['action', 'increment', 'increment'], ['action', 'reset', 'reset'],
    ]);
  });
});
