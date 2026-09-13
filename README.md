# Wicker: Symfony & Twig Tooling

A VS Code extension that makes working across Symfony controllers and Twig
templates feel like working in one language instead of two.

## Status

Early. The intelligence engine is real and tested; the editor integration is not
built yet. Concretely, what exists today is:

- Symfony project discovery from conclusive evidence, with the reasons recorded
- Twig template reference parsing, covering the `@Namespace` and `@!Namespace`
  forms and rejecting the syntax Symfony 5 removed
- Namespace resolution from `bin/console debug:twig --format=json` **or** from
  `config/packages/twig.yaml` alone, so it works with no PHP available
- A template index queryable by name and by file, modelling override order
- Template references found in PHP: `render()` and its siblings, `#[Template]`,
  named arguments, and the context keys passed alongside
- Template references found in Twig: `extends`, `include`, `embed`, `use`,
  `import`, `from`, and the `include()` and `source()` functions
- `composer.json` parsing with a PSR-4 map that resolves a class to its file and
  back again

Pointed at a real Symfony 8.1 application, that resolves every one of its 34
template references, from both sides, with no false positives.

There is no installable extension yet. See [Roadmap](#roadmap).

## Why it exists

A Symfony request crosses a boundary that editors normally lose track of: a
controller names a template as a bare string, passes it an array of variables,
and neither side can see the other. Wicker's goal is to close that gap, so that
the template name is navigable, the variables the controller passes are known
inside the template, and a typo in either direction is an error you see while
typing rather than at runtime.

## Architecture

Three packages, so the intelligence is not welded to one editor:

| Package | Contents |
| --- | --- |
| `packages/core` | The engine. Pure TypeScript, no editor or protocol dependencies, fully unit-testable. |
| `packages/server` | A Language Server Protocol server wrapping the engine. Not yet started. |
| `packages/vscode` | The VS Code extension: LSP client plus the features LSP has no shape for. Not yet started. |

Two conventions in the engine are worth knowing before reading the code.

**Paths are project-relative.** Everything indexed, compared, or reported is a
forward-slashed path relative to the project root. This is what lets a single
index stay correct when Symfony sees the project at `/app` inside a container
while the editor sees it on a Windows drive or through a WSL UNC path. It is
also why `debug:twig` reporting its loader paths relative to the project root is
so convenient.

**The console is a data source, not a dependency.** Symfony can describe itself
through `debug:twig`, `debug:router`, and `debug:container`. Wicker consumes that
where it is available and falls back to static analysis where it is not, so the
extension still works when PHP cannot be run.

## Development

Requires Node 20.19 or newer.

```bash
npm install
npm run check
```

`check` runs the whole gate: type checking, linting, and tests.

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile every package |
| `npm run typecheck` | Type check without emitting |
| `npm run lint` | ESLint across the repo |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run tests in watch mode |

## Roadmap

Built one capability at a time, each finished before the next starts.

1. **The controller and template bridge.** Go to definition, hover, completion,
   and missing-template diagnostics on every template reference, in both PHP and
   Twig. Then the reverse direction, and the variables a controller passes made
   known inside the template it renders.
2. Routes: completion and navigation for route names and `path()` / `url()`.
3. Services and the container: autowiring and parameter intelligence.
4. Translations, forms, and the rest of the Symfony surface.

## License

MIT. See [LICENSE](LICENSE).
