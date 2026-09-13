import { describe, expect, it } from 'vitest';

import { scanTwigTemplateReferences, type TwigTemplateReference } from './twigReferences.js';

/**
 * Scans and asserts the invariant callers rely on: the reported name range
 * must select exactly the template name in the original source.
 */
function scan(source: string): readonly TwigTemplateReference[] {
  const references = scanTwigTemplateReferences(source);
  for (const reference of references) {
    expect(source.slice(reference.nameRange.start, reference.nameRange.end)).toBe(
      reference.templateName,
    );
  }
  return references;
}

function names(source: string): readonly string[] {
  return scan(source).map((reference) => reference.templateName);
}

describe('tags that name a template', () => {
  it.each([
    ["{% extends 'base.html.twig' %}", 'extends', 'base.html.twig'],
    ["{% include 'task/_row.html.twig' %}", 'include', 'task/_row.html.twig'],
    ["{% embed '@Design/card.html.twig' %}{% endembed %}", 'embed', '@Design/card.html.twig'],
    ["{% use 'blocks.html.twig' %}", 'use', 'blocks.html.twig'],
    ["{% import 'macros.html.twig' as m %}", 'import', 'macros.html.twig'],
    ["{% from 'macros.html.twig' import field %}", 'from', 'macros.html.twig'],
  ])('%s', (source, kind, templateName) => {
    const references = scan(source);
    expect(references).toHaveLength(1);
    expect(references[0]?.kind).toBe(kind);
    expect(references[0]?.templateName).toBe(templateName);
  });

  it('handles whitespace control modifiers', () => {
    expect(names("{%- extends 'base.html.twig' -%}")).toEqual(['base.html.twig']);
  });

  it('handles a double-quoted name', () => {
    expect(names('{% extends "base.html.twig" %}')).toEqual(['base.html.twig']);
  });

  it('skips _self, which names the current template rather than a file', () => {
    expect(names('{% import _self as forms %}')).toEqual([]);
    expect(names('{% from _self import field %}')).toEqual([]);
  });
});

describe('not mistaking context values for templates', () => {
  it('ignores strings inside a with clause', () => {
    // The live app writes exactly this shape.
    expect(
      names("{% include 'task/_row.html.twig' with { task: task, label: 'a.html.twig' } only %}"),
    ).toEqual(['task/_row.html.twig']);
  });

  it('ignores strings after an import alias', () => {
    expect(names("{% import 'macros.html.twig' as 'not/a/template.twig' %}")).toEqual([
      'macros.html.twig',
    ]);
  });

  it('ignores the second argument of the include function', () => {
    expect(
      names("{{ include('@Design/button.html.twig', { href: path('x'), label: 'New task' }) }}"),
    ).toEqual(['@Design/button.html.twig']);
  });

  it('ignores ignore missing and only', () => {
    expect(names("{% include 'a.html.twig' ignore missing only %}")).toEqual(['a.html.twig']);
  });
});

describe('the include and source functions', () => {
  it('reads include()', () => {
    const references = scan("{{ include('@Design/button.html.twig') }}");
    expect(references[0]?.kind).toBe('include-function');
  });

  it('reads source()', () => {
    const references = scan("{{ source('snippets/raw.html.twig') }}");
    expect(references[0]?.kind).toBe('source-function');
  });

  it('reads a call nested inside a larger expression', () => {
    expect(names("{{ foo ? include('a.html.twig') : '' }}")).toEqual(['a.html.twig']);
  });

  it('ignores an unrelated function that takes a string', () => {
    expect(names("{{ path('task_index') }}")).toEqual([]);
  });
});

describe('several candidates', () => {
  it('reports every entry of a bracketed list', () => {
    const references = scan("{% include ['a.html.twig', 'b.html.twig'] %}");
    expect(references.map((r) => r.templateName)).toEqual(['a.html.twig', 'b.html.twig']);
    expect(references.every((r) => r.isCandidateList)).toBe(true);
  });

  it('reports both branches of a ternary', () => {
    const references = scan("{% extends admin ? 'admin.html.twig' : 'base.html.twig' %}");
    expect(references.map((r) => r.templateName)).toEqual(['admin.html.twig', 'base.html.twig']);
    expect(references.every((r) => r.isCandidateList)).toBe(true);
  });

  it('marks a single name as not a candidate list', () => {
    expect(scan("{% extends 'base.html.twig' %}")[0]?.isCandidateList).toBe(false);
  });
});

describe('names that are not statically known', () => {
  it('skips a variable', () => {
    expect(names('{% extends layout %}')).toEqual([]);
  });

  it('skips concatenation rather than reporting the leading fragment', () => {
    expect(names("{% include 'page/' ~ slug ~ '.html.twig' %}")).toEqual([]);
  });

  it('skips an interpolated double-quoted name', () => {
    expect(names('{% include "page/#{slug}.html.twig" %}')).toEqual([]);
  });

  it('still reads a name containing a tilde inside the quotes', () => {
    expect(names("{% include 'a~b.html.twig' %}")).toEqual(['a~b.html.twig']);
  });
});

describe('lexing hazards', () => {
  it('ignores references inside a comment', () => {
    expect(names("{# {% extends 'base.html.twig' %} #}")).toEqual([]);
  });

  it('is not confused by a closing delimiter inside a string', () => {
    expect(names(`{{ include('a.html.twig') }}{{ "why %} not" }}`)).toEqual(['a.html.twig']);
  });

  it('handles an unterminated tag at end of file', () => {
    expect(() => scan("{% extends 'base.html.twig'")).not.toThrow();
  });

  it('finds nothing in plain markup', () => {
    expect(names('<p>Nothing here at all.</p>')).toEqual([]);
  });

  it('finds nothing in an empty document', () => {
    expect(names('')).toEqual([]);
  });
});

describe('a realistic template', () => {
  // templates/task/index.html.twig from the live app, verbatim.
  const source = `{% extends 'base.html.twig' %}

{% block title %}Tasks{% endblock %}

{% block body %}
    <h1>Tasks</h1>

    <p class="summary">
        {{ openCount }} open, {{ doneCount }} done.
        {% include '_partials/alert.html.twig' with { tone: 'info', message: 'Showing newest first.' } only %}
    </p>

    {% if tasks is empty %}
        {% include '_partials/empty_state.html.twig' with {
            heading: 'No tasks yet',
            hint: 'Create the first one to get started.',
            href: path('task_new')
        } only %}
    {% else %}
        <ul class="task-list">
            {% for task in tasks %}
                {% include 'task/_row.html.twig' with { task: task } only %}
            {% endfor %}
        </ul>
    {% endif %}

    {{ include('@Design/button.html.twig', { href: path('task_new'), label: 'New task' }) }}
{% endblock %}
`;

  it('finds every reference and nothing else', () => {
    expect(names(source)).toEqual([
      'base.html.twig',
      '_partials/alert.html.twig',
      '_partials/empty_state.html.twig',
      'task/_row.html.twig',
      '@Design/button.html.twig',
    ]);
  });

  it('classifies each reference', () => {
    expect(scan(source).map((r) => r.kind)).toEqual([
      'extends',
      'include',
      'include',
      'include',
      'include-function',
    ]);
  });
});
