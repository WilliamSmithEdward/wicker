import { describe, expect, test } from 'vitest';
import { phpTypeDeclarations } from './dependencies.js';

describe('controller dependency declarations', () => {
  test('reads constructor, method and property types with imports and precise declaration offsets', () => {
    const source = `<?php namespace App\\Controller;
use App\\Repository\\TaskRepository as Tasks;
use App\\Service\\Mailer;
#[Route('/tasks', methods: ['GET'])]
final class TaskController {
  public function __construct(#[Autowire(service: 'tasks')] private readonly Tasks $tasks) {}
  #[Required] public Mailer $mailer;
  public function index(?Tasks $tasks, string $name = 'ignored'): Response { return $this->render('task.html.twig'); }
}`;
    const [type] = phpTypeDeclarations(source);
    expect(type?.name).toBe('App\\Controller\\TaskController');
    expect(source.slice(type!.range.start, type!.range.end)).toBe('TaskController');
    expect(type?.dependencies).toEqual([
      { typeName: 'App\\Repository\\TaskRepository', variable: '$tasks', methodName: '__construct' },
      { typeName: 'App\\Service\\Mailer', variable: '$mailer' },
      { typeName: 'App\\Repository\\TaskRepository', variable: '$tasks', methodName: 'index' },
    ]);
  });
  test('resolves grouped imports, namespace aliases, fully qualified and namespace-relative names', () => {
    const [type] = phpTypeDeclarations(`<?php namespace App\\Controller;
use App\\{Repository\\TaskRepository as Tasks, Service\\Mailer, function ignored, const VERSION};
use App\\Service as Services, App\\Entity\\Task;
class C { function run(Tasks $a, Mailer $b, Services\\Mailer $c, \\App\\Entity\\Task $d, namespace\\Local $e, Task $f) {} }`);
    expect(type!.dependencies.map((dep) => dep.typeName)).toEqual([
      'App\\Repository\\TaskRepository', 'App\\Service\\Mailer', 'App\\Service\\Mailer',
      'App\\Entity\\Task', 'App\\Controller\\Local', 'App\\Entity\\Task',
    ]);
  });
  test('keeps namespaces and imports scoped, including braced and global namespaces', () => {
    const types = phpTypeDeclarations(`<?php
namespace One { use App\\Service\\Mailer as M; class C { function run(M $m) {} } }
namespace Two { interface M {} class C { function run(M $m) {} } }
namespace { enum Status { case Open; } class C { function run(Status $s) {} } }`);
    expect(types.map((type) => [type.name, type.kind])).toEqual([
      ['One\\C', 'class'], ['Two\\M', 'interface'], ['Two\\C', 'class'], ['Status', 'enum'], ['C', 'class'],
    ]);
    expect(types[0]!.dependencies[0]!.typeName).toBe('App\\Service\\Mailer');
    expect(types[2]!.dependencies[0]!.typeName).toBe('Two\\M');
    expect(types[4]!.dependencies[0]!.typeName).toBe('Status');
  });
  test('ignores imports alone, return types, local closures, anonymous classes, strings and PHPDoc', () => {
    const [type] = phpTypeDeclarations(`<?php namespace App;
use App\\Unused;
/** @property Fake $fake */
class C {
  public function run(): ReturnType {
    $closure = function (Hidden $hidden) {};
    $arrow = fn (Hidden $hidden) => $hidden;
    $anonymous = new class { function run(Hidden $hidden) {} };
    $text = 'function fake(Hidden $hidden) {}';
  }
  public static function factory(Hidden $hidden) {}
}`);
    expect(type!.dependencies).toEqual([]);
  });
  test('ignores ambiguous types and scalars; accepts nullable, reference and variadic parameters', () => {
    const [type] = phpTypeDeclarations(`<?php class C {
function f(Foo|Bar $union, Foo&Bar $intersection, (Foo&Bar)|Baz $dnf, int $id, self $self,
  ?Foo $nullable, Foo &$reference, Foo ...$many) {}
}`);
    expect(type!.dependencies.map((dep) => dep.variable)).toEqual(['$nullable', '$reference', '$many']);
  });
  test('keeps defaults opaque and handles multiple properties and abstract method declarations', () => {
    const [type] = phpTypeDeclarations(`<?php namespace App;
abstract class C {
  protected Foo $first, $second;
  public array $ignored = ['function', 'Fake $fake'];
  abstract function run(#[Attr(values: [1, 2])] Foo $foo = new Foo(1, 2));
}`);
    expect(type!.dependencies.map((dep) => dep.variable)).toEqual(['$first', '$second', '$foo']);
  });
  test('malformed in-progress declarations fail quietly', () => {
    for (const source of ['<?php class C { function run(Foo $foo', '<?php namespace App { class C {', '<?php class C { #[Broken(] function run(Foo $foo) {} }']) {
      expect(phpTypeDeclarations(source)).toEqual([]);
    }
  });
});
