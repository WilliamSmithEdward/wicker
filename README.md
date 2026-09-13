# Wicker: Symfony & Twig Tooling

A VS Code extension that makes working across Symfony controllers and Twig
templates feel like working in one language instead of two.

## Status

Early, and working. The first capability, the bridge between a controller and
the template it renders, is finished and driven from the editor.

In the editor today:

- Go to definition on every template name, from PHP and from Twig
- Hover naming the resolved file, the reference that reached it, and the
  variables the controller passes
- Completion of indexed template names inside the quotes
- Diagnostics for a template that resolves to nothing, distinguishing a missing
  file from an unregistered namespace, and staying silent on a name built at
  runtime
- A quick fix that creates the missing file, which declines when the namespace
  is unregistered and there is nowhere correct to put it
- Template names that resolve coloured as their own semantic token, so the
  references the extension actually understands are visible in the code
- Twig syntax highlighting, with HTML, JavaScript and CSS embedded

Underneath it:

- Symfony project discovery from conclusive evidence, with the reasons recorded
- Twig template reference parsing, covering the `@Namespace` and `@!Namespace`
  forms and rejecting the syntax Symfony 5 removed
- Namespace resolution from `bin/console debug:twig --format=json`, remembered
  so a stopped container does not lose it, falling back to
  `config/packages/twig.yaml` so it works with no PHP available at all
- A template index queryable by name and by file, modelling override order
- Template references found in PHP: `render()` and its siblings, `#[Template]`,
  named arguments, and the context keys passed alongside
- Template references found in Twig: `extends`, `include`, `embed`, `use`,
  `import`, `from`, and the `include()` and `source()` functions
- `composer.json` parsing with a PSR-4 map that resolves a class to its file and
  back again

Pointed at a real Symfony 8.1 application, that resolves every one of its 34
template references, from both sides, with no false positives. The editor
features are covered by integration tests that drive a real VS Code instance
against a fixture project.

Not yet published to the marketplace. Build it and run it from source with the
instructions under [Development](#development).

## Why it exists

A Symfony request crosses a boundary that editors normally lose track of: a
controller names a template as a bare string, passes it an array of variables,
and neither side can see the other. Wicker's goal is to close that gap, so that
the template name is navigable, the variables the controller passes are known
inside the template, and a typo in either direction is an error you see while
typing rather than at runtime.

## No dependencies

The extension ships no third-party runtime code. Its parsers are its own: a
Twig lexer, a PHP lexer, and a reader for the subset of YAML that Symfony
configuration uses. Nothing is bundled that was not written for it.

That is a deliberate constraint rather than a boast. It keeps the supply chain
empty, keeps the bundle small, and means every behaviour is one the project can
change. Build tooling is a separate matter and stays conventional.

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

`check` runs the whole gate: a build first, since the extension type checks
against the engine's emitted declarations, then type checking, linting and
tests.

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile every package |
| `npm run typecheck` | Type check without emitting |
| `npm run lint` | ESLint across the repo |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:integration -w wicker` | Drive the extension in a real VS Code instance |

### Running it against a project

Build the extension, then open a Symfony project in a window that loads it from
this checkout:

```bash
npm run build -w wicker
code --extensionDevelopmentPath=/path/to/wicker/packages/vscode /path/to/symfony-app
```

Namespaces registered by bundles are declared in no configuration file, so
Wicker asks `bin/console debug:twig` for them. When PHP is not on the same
machine as the editor, say because the application runs in a container, tell it
how to reach the console in the project's `.vscode/settings.json`:

```json
{
  "wicker.console.command": ["docker", "exec", "my-php-1", "php", "bin/console"]
}
```

Without that it falls back to `config/packages/twig.yaml`, which resolves the
namespaces an application declares for itself but not the ones its bundles
register.

## Roadmap

Built one capability at a time, each finished before the next starts.

**Done.** The controller and template bridge: go to definition, hover,
completion, missing-template diagnostics and semantic colouring on every
template reference from both PHP and Twig, with a quick fix that creates the
file. Twig syntax highlighting with HTML, JavaScript and CSS embedded.

Next, in order:

1. **Twig language intelligence.** Variables a controller passes made known
   inside the template it renders, and the reverse direction: an open template
   naming the controllers that render it. Unknown filters and functions checked
   against the real list from `debug:twig`, which a grammar can only guess at.
2. **Symfony UX and Twig Components.** `<twig:Button />` resolved to its class
   and template, with prop completion. This is one feature family covering
   [Twig Components](https://symfony.com/bundles/ux-twig-component/current/index.html),
   [Live Components](https://ux.symfony.com/live-component),
   [UX Toolkit](https://ux.symfony.com/toolkit),
   [Icons](https://ux.symfony.com/icons) and
   [CalendarLink](https://ux.symfony.com/calendar-link).
3. **Routes.** Completion and navigation for route names, `path()` and `url()`.
4. **Services and the container.** Autowiring and parameter intelligence.
5. **PHP as a language, not just as Symfony.** Navigation, completion, hover
   and diagnostics across a PHP codebase: symbols, types, use statements,
   inheritance. The PHP lexer written for the template bridge is the
   foundation; a full parser and symbol index go on top of it. This is large
   enough to be released in stages alongside the Symfony work rather than
   after it.
6. Translations, forms, and the rest of the Symfony surface.

## License

MIT. See [LICENSE](LICENSE).
