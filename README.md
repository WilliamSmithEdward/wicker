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
- Twig variable completion and hover showing the PHP calls that supply each
  literal context key, updated as the controller is edited
- Diagnostics for a template that resolves to nothing, distinguishing a missing
  file from an unregistered namespace, and staying silent on a name built at
  runtime
- A quick fix that creates the missing file, which declines when the namespace
  is unregistered and there is nowhere correct to put it
- Template names that resolve coloured as their own semantic token, so the
  references the extension actually understands are visible in the code
- Twig syntax highlighting, with HTML, JavaScript and CSS embedded
- "Rendered by" links above a Twig template, opening each PHP render call or
  `#[Template]` attribute that resolves to it, including unsaved PHP edits
- A Wicker sidebar with a leaf icon, detected projects, namespace status and
  templates grouped by namespace

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

[Install Wicker from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=WilliamSmithE.wicker)

Or build it and run it from source with the instructions under
[Development](#development).

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
| `packages/vscode` | The VS Code extension, calling the engine directly through native editor providers. |

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

### Browsing the sidebar

Click the leaf in the Activity Bar to open Wicker. Each Symfony project shows
**Controllers** and **Templates** sections.
Under **Controllers**, expand a controller and an action to see its template
targets. Clicking the controller opens its PHP file; clicking an action selects
its first render call or `#[Template]` attribute; clicking a resolved target opens
the Twig file. Unresolved names stay visible with a warning.

This view includes literal template references in classes following the
`Controller` directory, namespace or class-suffix convention. Actions follow
source order. Methods without literal template references are omitted, and
rendering services outside those conventions remain available through
**Rendered by** links. Unsaved PHP edits update the tree.

Under **Templates**, expand **Application** or a named
namespace to browse collapsible folders, with folders sorted before files and
template counts beside them. Click a filename to open the file Twig resolves
to; its tooltip retains the full template name and project path.

The title buttons reveal the current template, rebuild the index, and open
Wicker settings. Bundle namespaces such as `@Turbo` are hidden by default;
application namespaces such as `@Design` and overrides under **Application →
bundles** remain visible. The eye button shows or hides bundle templates and
remembers that choice for this workspace. Revealing an open bundle template
also shows bundle namespaces. This filter affects browsing under **Templates**;
explicit controller targets, navigation, completion and diagnostics still use
the full index.

Hover the project name to see where namespaces came from. Limited namespace
discovery or a truncated index shows an expandable warning with **Retry** and
the relevant **Settings** action. A saved Symfony namespace list stays in the
tooltip while the console is unavailable. Right-click a project and choose
**Show diagnostics** to open its detailed report in Output. The same command
in the Command Palette reports all detected projects.

The tree updates when template files or configuration change.
Turning off `wicker.enable` replaces the tree with a link to settings so it can
be enabled again. In an empty workspace, the sidebar offers to open a Symfony
application folder.

### Navigating back to PHP

Open a Twig template and click a `Rendered by Controller::method` link above
its first line to select the template name in that PHP call or attribute. Each
render site has its own link. VS Code's `editor.codeLens` setting controls
whether these links are visible.

Wicker scans project PHP files outside `vendor`, `var`, `node_modules`, and
`.git`. Links follow unsaved edits, file changes, and Twig loader precedence.
Only direct, literal render references count: an inherited layout or included
partial does not borrow its caller's controllers, and runtime template names
are not guessed. Turning off `wicker.enable` hides the links too.

### Controller variables in Twig

When a PHP call renders a literal template name with an array such as
`['tasks' => $tasks, 'heading' => 'Tasks']`, Wicker suggests `tasks` and
`heading` at Twig expression positions. Type inside `{{ }}` or press
Ctrl+Space to see suggestions. Hover a supplied variable to see the controller
method, render call and source file. Both features follow unsaved PHP edits.

A template rendered by several calls receives the union of their known keys.
Hover reports how many indexed calls explicitly supply a key and identifies
those calls. A key supplied by one call may be absent from another; Wicker
does not infer its type or promise that it always exists.

This first pass reads literal context arrays at direct render sites. It does
not follow PHP variables, method return arrays for `#[Template]`, inheritance
or includes. Twig assignments, loop bindings and macro aliases hide matching
controller names; isolated scopes and expressions with bindings that Wicker
cannot resolve are omitted. These are context suggestions, with no
unknown-variable diagnostics. Turning off `wicker.enable` disables them.

## Roadmap

Built one capability at a time, each finished before the next starts.

**Done.** The controller and template bridge: go to definition, hover,
completion, missing-template diagnostics and semantic colouring on every
template reference from both PHP and Twig, with a quick fix that creates the
file. Twig syntax highlighting with HTML, JavaScript and CSS embedded. Reverse
navigation from a template to its PHP render calls and attributes. A native
sidebar for browsing controllers, actions and templates by namespace. Controller context
keys suggested inside Twig, with hover identifying their PHP sources.

Next, in order:

1. **Twig language intelligence.** Extend variable understanding through Twig
   scopes, includes and inheritance. Unknown filters and functions checked
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
5. Translations, forms, and the rest of the Symfony surface.

### Not planned: PHP as a general language

Navigation, completion and diagnostics across a PHP codebase at large, the
things an established PHP extension already does, are deliberately out of
scope.

The reason is how VS Code resolves overlapping extensions. Hovers and
definitions merge, so two extensions can both contribute. Completion does not:
providers are grouped by selector score and the first group to answer wins,
so a lower-scoring provider is never asked. Semantic tokens are stricter
still, with one provider selected outright. Competing for those slots is
decided by selector specificity and, on a tie, by whichever extension
activated last.

That is a contest with no good outcome. Winning it means replacing a mature
PHP implementation with a newer one; losing it means shipping features that
silently never run. Neither is worth it when the gap actually worth closing is
the one between a controller and its template, which nothing else covers.

Wicker stays on Symfony and Twig, and expects to be installed next to a PHP
extension rather than instead of one.

## License

MIT. See [LICENSE](LICENSE).
