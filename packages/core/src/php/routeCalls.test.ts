import { describe, expect, it } from 'vitest';
import { phpRouteCalls } from './routeCalls.js';

describe('phpRouteCalls', () => {
  const source = `<?php
class C {
  function a() { return $this->redirectToRoute('item_show', ['id' => $id, "page" => 2]); }
  function b() { return $this->generateUrl('item_list'); }
  function c() { return $this->generateUrl('item_show', $params); }
  function d() { return $this->generateUrl('item_show', ['id' => 1] + $extra); }
  function e() { return $this->generateUrl($name, ['id' => 1]); }
  function f() { return $this->redirectToRoute('item_show', [...$base, 'id' => 1]); }
  function g() { return $this->router->generate('item_show', ['id' => 1]); }
  function h() { return $this->generateUrl('item_show', ['id' => 1, '']); }
}`;

  it('reads the route name and the literal keys of the generator helpers', () => {
    expect(phpRouteCalls(source).map((call) => [call.name, call.keys])).toEqual([
      ['item_show', ['id', 'page']], ['item_list', []], ['item_show', undefined], ['item_show', undefined], ['item_show', undefined],
      // A key still being typed keeps the array literal, so the rest of it can be completed.
      ['item_show', ['id']],
    ]);
  });

  it('keeps the name and each key at its own offsets, inside the quotes', () => {
    const [call] = phpRouteCalls(source);
    expect(source.slice(call!.nameRange.start, call!.nameRange.end)).toBe('item_show');
    expect(call!.parameters.map((parameter) => source.slice(parameter.range.start, parameter.range.end))).toEqual(['id', 'page']);
    expect(source.slice(call!.arguments!.start, call!.arguments!.end)).toBe(`'id' => $id, "page" => 2`);
  });
});
