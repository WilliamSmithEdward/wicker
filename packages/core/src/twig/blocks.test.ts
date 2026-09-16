import { describe, expect, it } from 'vitest';
import { twigBlocks, twigEmbeds } from './blocks.js';

describe('twigBlocks', () => {
  const source = `{% extends 'base.html.twig' %}
{% block title 'Tasks' %}
{% block body %}
  {% block inner %}x{% endblock inner %}
  {% embed 'card.html.twig' %}{% block card_body %}y{% endblock %}{% endembed %}
{% endblock %}
{% verbatim %}{% block ignored %}{% endverbatim %}
{% block trailing %}`;

  it('reads nested, inline, embedded and unclosed blocks in source order', () => {
    expect(twigBlocks(source).map((block) => [block.name, block.depth, block.embed ?? null])).toEqual([
      ['title', 0, null], ['body', 0, null], ['inner', 1, null], ['card_body', 1, 'card.html.twig'], ['trailing', 0, null],
    ]);
  });

  it('keeps exact ranges for the name, the tag and the whole block', () => {
    const text = (range: { start: number; end: number }): string => source.slice(range.start, range.end);
    const by = (name: string) => twigBlocks(source).find((block) => block.name === name)!;
    expect(text(by('body').nameRange)).toBe('body');
    expect(text(by('body').range).startsWith('{% block body %}')).toBe(true);
    expect(text(by('body').range).endsWith('{% endblock %}')).toBe(true);
    expect(text(by('title').range)).toBe(`{% block title 'Tasks' %}`);
    expect(by('trailing').range.end).toBe(source.length);
  });

  it('records each embed with the template it takes its blocks from', () => {
    expect(twigEmbeds(source).map((embed) => embed.template)).toEqual(['card.html.twig']);
    expect(twigEmbeds(`{% embed layout ~ '.twig' %}{% block a %}{% endblock %}`).map((embed) => [embed.template, embed.range.end]))
      .toEqual([['', 55]]);
  });
});
