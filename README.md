# Wicker: Symfony & Twig Tooling

Wicker aims to be a one-stop shop for Symfony and Twig development in VS Code,
with a developer experience that is a joy to use and lowers cognitive load as
much as possible. It starts by connecting controllers and templates directly
in the editor.

## Status

Early, and working. The first capability, the bridge between a controller and
the template it renders, is finished and driven from the editor.

In the editor today:

- Go to definition on every template name, from PHP and from Twig
- Hover naming the resolved file, the reference that reached it, and the
  variables the controller passes
- Completion of indexed template names inside the quotes
- Twig variable completion and hover from controller keys, local bindings,
  literal includes and inheritance, updated as PHP or Twig is edited
- Twig filter and function completion from the project's console discovery,
  with hover, official reference links for standard names and unknown-name warnings
- Twig Component name and prop completion, hover and navigation to the registered
  PHP class, Twig template and prop declarations
- Diagnostics for a template that resolves to nothing, distinguishing a missing
  file from an unregistered namespace, and staying silent on a name built at
  runtime
- A quick fix that creates the missing file, which declines when the namespace
  is unregistered and there is nowhere correct to put it
- Template names that resolve coloured as their own semantic token, so the
  references the extension actually understands are visible in the code
- Twig syntax highlighting, with HTML, JavaScript and CSS embedded
- "Rendered by" links above a Twig template, opening each PHP render call or
  `#[Template]` attribute that resolves to it, including unsaved PHP edits, and
  a count of the templates extending it
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

The wider vision connects the Symfony ecosystem through consistent navigation,
completion and explanations. Developers should spend less time remembering
names, finding related files, switching contexts and configuring tools. Project
discovery and automatic updates keep assistance relevant; a calm interface
puts useful information at the point of work and deeper detail within reach.
Each feature should make a real development task easier from start to finish.

That experience should work for people learning Symfony and those who use it
every day. Discoverable actions and explanations should help people get started
with a workflow, while familiar, efficient interactions keep it pleasant as
their experience grows. Real use and iteration will guide what comes next.

The focus begins once a project is set up. Initial project and environment setup
are outside the intended scope; the ambition for everyday development after
that is broad. Creating application code, refactoring, running project commands,
testing and debugging are possible future directions alongside editor
intelligence, evaluated one capability at a time.

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

Action rows lead with their registered HTTP method and URL, such as
`GET /dashboard`, with `index()` as secondary detail. When route discovery is
unavailable, the method name stays visible beside its template targets.
Hover shows all registered routes and rendered templates for the action. Route
rows sort by URL path in every section, including under controllers.

This view includes literal template references in classes following the
`Controller` directory, namespace or class-suffix convention. Actions without a
known route follow routed actions, retaining source order. Methods without literal template references are omitted, and
rendering services outside those conventions remain available through
**Rendered by** links. Unsaved PHP edits update the tree.

A controller's **Dependencies** branch links project types declared on its
constructor, method parameters and properties: services, repositories, entities
and other classes or interfaces. Each type appears once; hover lists the
parameters and methods that declare it. Imports and aliases resolve to actual
project declarations, including current unsaved buffers. Interfaces open their
declaration. Container aliases, inherited dependencies, dynamic service lookups,
union/intersection types, vendor types and ambiguous declarations are not
inferred. Service, Repository and Entity namespaces supply distinct role icons;
other dependencies use their PHP declaration kind.

Expand a Twig file to see its associated **JavaScript and TypeScript files**.
Controllers collect these in a **Scripts** branch, together with scripts that
reference their routes. Connections follow registered Stimulus bindings and
literal Twig includes, embeds and layouts; hover explains each connection.
Dynamic includes, general asset/import-map entrypoints and arbitrary script
imports are not followed. Clicking a template still opens Twig, and clicking a
script opens that file.

When generated JavaScript explicitly links a local source map with one existing
TypeScript source, the tree prefers that source and merges duplicate script
entries. Hover retains the generated file path. Independent same-named files,
multi-source bundles, missing maps and missing sources keep their own identity.
Both external local `.map` files and inline maps are supported; remote maps are
not fetched. This preference changes tree navigation, not Stimulus registration.

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

The sidebar follows the active editor: opening a template selects its row, as
the Explorer selects the active file. `wicker.sidebar.autoReveal` turns that
off. The Reveal button in the view title still finds the current template, and
shows bundle templates when it is one of those.

Right-click a row to open its file to the side, reveal it in the Explorer, or
copy what it names: a template's logical name, ready for `render()` or an
include tag, a Stimulus controller's identifier, or a route's name or path.

**Wicker: Go to Template** in the Command Palette opens a template by its
logical name, which Quick Open cannot match when the name and the path differ,
as they do for a namespace or a bundle override.

Rows are coloured by what they are: green for templates, purple for PHP,
yellow for JavaScript, blue for TypeScript, cyan for API routes, orange for
Stimulus, magenta for stylesheets and red for components.
`wicker.sidebar.colors` turns the colours off, and only warnings keep theirs.

### Navigating back to PHP

Open a Twig template and click a `Rendered by Controller::method` link above
its first line to select the template name in that PHP call or attribute. Each
render site has its own link, and a layout also reports how many templates
extend it. Both are the direction the file cannot state about itself: what a
template extends is on its own first line and already navigates.

`wicker.codeLens.enabled` turns these links off, and VS Code's own
`editor.codeLens` setting hides every extension's links at once. The same two
connections are also rows under a template in the Wicker sidebar, where they
can be browsed without opening the file.

Wicker scans project PHP files outside `vendor`, `var`, `node_modules`, and
`.git`. Links follow unsaved edits, file changes, and Twig loader precedence.
Only direct, literal render references count: an inherited layout or included
partial does not borrow its caller's controllers, and runtime template names
are not guessed. Turning off `wicker.enable` hides the links too.

### Variables in Twig

When a PHP call renders a literal template name with an array such as
`['tasks' => $tasks, 'heading' => 'Tasks']`, Wicker suggests `tasks` and
`heading` at Twig expression positions. Type inside `{{ }}` or press
Ctrl+Space to see suggestions. Hover a supplied variable to see the controller
method, render call and source file. Both features follow unsaved PHP edits.

A template rendered by several calls receives the union of their known keys.
Hover reports how many indexed calls explicitly supply a key and identifies
those calls. A key supplied by one call may be absent from another; Wicker
does not infer its type or promise that it always exists.

Local `set` variables, loop keys and items, `loop`, macro parameters and literal
`with` keys are suggested in their scope. Loop bindings disappear outside the
loop; macros and `with ... only` do not borrow their enclosing context. Imported
macro aliases hide matching variable names.

Literal `include` tags and `include()` calls carry the caller's visible context
into the included template. Literal map keys add or replace variables; `only`
and `with_context: false` restrict suggestions to explicitly passed keys.
Hover identifies the PHP or Twig source and the include chain. Several callers
produce a union of possible inputs, not a promise that every input is available.

Literal `extends` relationships carry controller keys and child top-level
assignments into layouts. Child blocks can see parent assignments made before
the corresponding block. Sibling templates keep their own rendering context.
Unsaved PHP and Twig edits, discarded edits and file changes update these
suggestions automatically. The `Rendered by` links still describe direct PHP
render sites only.

Inference remains conservative: PHP variable arrays and `#[Template]` method
return values, dynamic template names, candidate lists, dynamic context maps,
cross-file `embed`/`use` behavior and arrow-function scopes are not inferred.
Template text and graph traversal have bounded limits. There are no inferred
value types or unknown-variable diagnostics. Turning off `wicker.enable`
disables all variable assistance.

### Twig blocks

A block overrides the nearest ancestor's block of the same name, and neither
file says so. Go to Definition on a block name, or on `parent()` inside the
block, opens the block it overrides. Find All References lists every
definition up and down the inheritance chain, and hover names the ancestor a
block overrides and the templates overriding it. After `{% block`, completion
offers the names the ancestors declare and this template has not overridden.
A top-level block that no ancestor defines is reported, because Twig renders
nothing for it and says nothing; `wicker.diagnostics.unknownBlock` turns that
down or off. Blocks inside `{% embed %}` are read against the embedded
template, `{% use %}` counts, and a layout named at runtime is left alone.

### Twig filters and functions

Type `|` after a value for filter suggestions, or use Ctrl+Space at a Twig
expression position for functions. Wicker reads the names registered in your
project from `debug:twig`, including custom extensions and installed bundles.
Hover a filter or function to see its registration, arguments reported by
Symfony, and an official reference link for recognized standard names.
Symfony's argument output can include implicit PHP parameters, so Wicker does
not present it as a Twig signature or insert argument placeholders.

Unknown filters and functions receive warnings when discovery is fresh and
complete. Wildcard registrations are recognized; methods, imported macros,
Twig tests, strings, comments and verbatim content are excluded. This is a
conservative reader of common Twig expressions and tags, not a full syntax
checker; custom tag syntax and string interpolation are not analyzed.

Saved application PHP, configuration, Composer and supported environment-file
changes refresh discovery automatically. Unsaved project changes suspend
unknown-name warnings until saved or discarded. If the console becomes
unavailable, these warnings and callable suggestions are cleared; template
namespace fallback continues to work. Runtime-only registrations that are not
listed by `debug:twig` cannot be discovered.

Set `wicker.diagnostics.unknownCallable` to `error`, `warning` (the default),
`information` or `off`. `wicker.enable` disables all of these surfaces, and
`wicker.console.enabled` controls console discovery. Show diagnostics from a
project's sidebar context menu reports the discovered callable counts.

### Twig Components

In a project using Symfony UX Twig Components, Wicker discovers registrations
with `debug:twig-component`. Complete names inside `<twig:...>`, closing tags,
`component('...')` and `{% component '...' %}`. Hover explains the registration;
Go to Definition offers its PHP class and Twig template when available locally.

Inside an opening component tag, Ctrl+Space suggests props from writable public
properties, setters and `mount()` parameters declared on the registered class.
Anonymous components use their template's `{% props %}` declarations. A suggested
prop inserts `name=""` with the cursor inside the quotes; an existing value is
preserved. Already supplied props are omitted. Hover or Go to Definition on a
prop identifies its declaration.

Prop suggestions follow unsaved PHP/Twig edits. Saved PHP, configuration and
dependency changes, plus template creation/deletion, refresh registrations.
Console execution must be enabled and the workspace trusted. In Restricted
Mode, and in a virtual workspace, the console is not run and everything else
still works. When discovery is unavailable, component assistance stays quiet;
the project's diagnostics report explains why. No unknown-component or
unknown-prop warnings are added.

This first component step covers literal names and directly declared props.
Inherited/trait props, dynamic component names, prop type checking, custom
property hooks and Live Component behavior are not inferred. Classes outside
the application's Composer PSR-4 mappings still link to their indexed template.

### Live Components

In the template of a component the console reports as live, `data-model`
completes the props the class marks `#[LiveProp(writable: true)]`, past any
modifiers such as `on(change)|`, and `live_action()` and
`data-live-action-param` complete the methods marked `#[LiveAction]`. Hover
says what a name is and which file declares it; Go to Definition opens the
declaration. A `data-model` naming no prop, or a prop that is not writable,
and an action the class does not declare, are reported, because each is
refused when the request arrives and says nothing in the editor;
`wicker.diagnostics.unknownLiveMember` turns that down or off.

### Stimulus and API connections

In a StimulusBundle project, complete controller names in `data-controller`
and the `stimulus_controller()`, `stimulus_action()` and `stimulus_target()`
helpers. Complete action methods, targets and value keys, or Ctrl-click them
to open their JavaScript/TypeScript declarations. The same navigation works in
`data-action`, `data-…-target` and `data-…-value` attributes.

Wicker reads `debug:config stimulus` and maps the runtime project root back to
your workspace, including Docker projects. Local controller identifiers follow
StimulusBundle's configured directories and filename conventions. Enabled UX
controllers come from `controllers.json` and their installed package metadata.
Member suggestions cover direct declarations on a default exported class;
inherited/computed members and runtime registrations are not inferred.

Quick fixes write what a binding is already asking for. A controller nothing
registers is created in the configured directory, in TypeScript when the
project's controllers are. A method, target, value, class or outlet the
controller lacks is added to it. A relative import written without its
extension gains the one that exists. On a `data-controller` attribute, a
refactoring connects the controller to another through an outlet, declaring
it in the controller and binding it on the element in one edit.

Routes come from `debug:router --format=json`. In Twig, complete literal route
names in `path()` and `url()`, then navigate to the application's PHP action.
Inside the call, complete the route's parameters; hover lists each placeholder
with its requirement and default, and hover on a key says what it fills. A
call that names an unregistered route, or leaves out a placeholder its route
requires, is reported; `wicker.diagnostics.missingRouteParameter` turns that
down or off. A key the route does not declare is not an error, since Symfony
appends it as a query string. `redirectToRoute()` and `generateUrl()` in PHP
get the same completion, hover and checks, the route name included.
In JavaScript, Ctrl-click an unambiguous root-relative `fetch()` URL, or a
Stimulus URL value supplied by a Twig helper/data attribute, to follow the
request. When the action renders Twig, Go to Definition also offers its
template. Hover shows the route, response fields, rendered templates and known
consumers. Find All References on a route reference or PHP action name opens
its Twig and JavaScript consumers. **Wicker: Go to Route** in the Command
Palette lists every route whose action is in the workspace, by path, name and
controller, and opens the action.

The sidebar's **Template routes** branch lists routes whose actions render Twig
HTML. Click a URL to open its PHP action, or expand it to open the template. A
fragment that JavaScript fetches is still a template route, and its row says
which file fetches it.
The **API routes** branch appears when there are JSON endpoints, by response
format or by what the action returns. Click an endpoint to open its action;
expand it to browse what calls it. A `/api` path prefix alone does not claim
that an endpoint returns JSON, and a route that renders a template is never
listed here.
JSON routes use the `{}` object icon and routes rendering Twig a leaf with a
route arrow. Twig template files use a plain leaf. A row under a controller is
a PHP method and keeps the method icon whatever its route returns. The icons
include light and dark theme variants.

JSON field completion and navigation follow local awaited assignments:

```javascript
const response = await fetch(this.statusUrlValue);
const data = await response.json();
data.message; // Complete a field or open its PHP declaration.
```

This works in `.js`, `.ts` and JavaScript inside `<script>` blocks in Twig.
Fields come from literal arrays returned by `$this->json()` or a directly
constructed Symfony `JsonResponse`. Nested literal fields are supported;
multiple return branches expose their shared fields. JSON fetched in the
browser does not introduce server-side Twig variables.

Dynamic URLs, ambiguous routes, promise chains, cross-function data flow,
serializer/DTO schemas and external API contracts remain unknown. Wicker does
not call endpoints to inspect their responses. Application source edits,
including unsaved changes, update consumer links and declarations; saved PHP
and configuration changes refresh runtime registrations. Discovery requires a
trusted workspace and enabled console execution. No new warnings are added.

## Roadmap

Built one capability at a time, each finished before the next starts.
The intended scope spans the Symfony ecosystem, including its frontend
integrations through Symfony UX and Stimulus.

**Done.** The controller and template bridge: go to definition, hover,
completion, missing-template diagnostics and semantic colouring on every
template reference from both PHP and Twig, with a quick fix that creates the
file. Twig syntax highlighting with HTML, JavaScript and CSS embedded. Reverse
navigation from a template to its PHP render calls and attributes. A native
sidebar for browsing controllers, actions and templates by namespace. Controller context
keys suggested inside Twig, with hover identifying their PHP sources.
Filter and function completion, hover and unknown-name warnings grounded in
the project's Twig discovery.
Scoped local variables and context propagation through literal includes and
inheritance, with PHP/Twig sources identified on hover.
Twig Component name and prop completion, hover and navigation to registered
classes, templates and directly declared props.
Stimulus controller/action/target/value assistance, route navigation, API tree
connections and literal JSON response fields. Controller dependencies and
associated scripts connect the project tree, with source-map-based TypeScript
preference and distinct icons for templates, routes and project types.

Next, in order:

1. **Stimulus and AssetMapper: the rest of the coverage.** Shipped in 0.5.0:
   outlets, CSS classes, action descriptors, events between controllers,
   generated members, value types, mapped assets, importmaps and import
   navigation, explanations and a first repair. Since then: action parameters,
   value change callbacks, the loading chain as a browsable tree, CSS `url()`
   references, and the create and connect edits. Still open: a repair for a
   missing importmap entry, and connecting controllers written with the
   `stimulus_controller()` helper. The
   [sprint scope](docs/sprint-stimulus-assetmapper.md) records the status of
   every row.
2. **Symfony UX and Live Components.** Deepen component workflows through real
   use. This part of the roadmap covers
   [Twig Components](https://symfony.com/bundles/ux-twig-component/current/index.html),
   [Live Components](https://ux.symfony.com/live-component),
   [StimulusBundle](https://symfony.com/bundles/StimulusBundle/current/index.html),
   [UX Toolkit](https://ux.symfony.com/toolkit),
   [Icons](https://ux.symfony.com/icons) and
   [CalendarLink](https://ux.symfony.com/calendar-link).
3. **Routes and response contracts.** Extend the initial route and API connections
   with parameter assistance and additional explicitly traceable response shapes.
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
