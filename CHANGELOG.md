# Changelog

## 0.12.0

Stimulus bindings are checked in both directions.

### Added

- **A binding no member answers is reported.** An action naming no method, or
  a target, value, class or outlet in none of the controller's `static` lists,
  is reported where it is written, under
  `wicker.diagnostics.unknownStimulusMember`. Stimulus attaches nothing and
  reports nothing, in the browser or anywhere else.
- **A declaration no page fills is greyed.** A `static targets`, `classes` or
  `outlets` entry nothing binds is marked where it is declared, under
  `wicker.diagnostics.unusedStimulusMember`, since reading it throws where
  nothing provides it. Values are left out, because a value declares its own
  default, and actions because a method is callable from the controller
  itself. Both checks stand down for a controller built on a base class of
  your own, whose inherited members are not read.
- **Controllers group by namespace.** The part that tells them apart becomes
  a row, so `App\Controller\Admin\UserController` sits under **Admin**, while
  the namespace every controller shares is folded away and a project with one
  namespace is unchanged. `wicker.sidebar.controllerNamespaces` turns it off.

## 0.11.0

A controller is read by what it produces.

### Changed

- **The Controllers section leads with what a controller renders.** Each
  template is a row of its own with the action that renders it beneath, then
  the JSON endpoints, then any other action, in that order. What a page is
  called is the thing worth reading, and it used to sit a level down behind a
  chevron.
- **An action's icon says what it produces**, now read from the PHP rather
  than from its route: the leaf for Twig, the object for JSON, the plain
  method icon for neither. It no longer starts as a method and turns into a
  leaf once the console answers.

## 0.10.1

### Changed

- **Template routes group by path as well**, under the same setting, which is
  now `wicker.sidebar.routeHierarchy` because it governs both sections.
  `wicker.sidebar.apiRouteHierarchy`, from 0.10.0, is gone; set the new name
  to `false` for the flat list.
- **An action wears what its route does.** Under a controller, an action that
  renders Twig takes the leaf and one that answers JSON the object, so a page
  and an endpoint are told apart where the controller is read. A method no
  route reaches keeps the plain method icon.

## 0.10.0

The API routes open by path, and a controller that renders nothing has a row.

### Added

- **API routes as a hierarchy.** The section opens a path segment at a time,
  so `/api/v1/tasks/{id}` sits under api › v1 › tasks. Each folder counts what
  lies beneath it, and each row is named by its last segment with the whole
  path in its tooltip. `wicker.sidebar.apiRouteHierarchy`, on by default,
  gives the flat list with full paths back.

### Fixed

- **Controllers that only answer JSON.** The Controllers section was built
  from render calls alone, so a controller rendering nothing had no row. A
  controller is now listed when a route names it and counts all its actions,
  and an action that renders nothing opens where it is declared instead of
  opening nothing.
- **Scripts and styles in a project that generates its import map.**
  `importmap()` is read whether it takes one entrypoint or a list, and a
  generated `#` alias passed to it is followed to the asset it names. Where
  neither was read a template had no entrypoint, and so no scripts or
  stylesheets beneath it.

## 0.9.3

### Fixed

- **A project that generates its import map.** `importmap.php` is the whole
  import map only while Symfony's own reader reads it. Where a project's
  configuration or PHP names `asset_mapper.importmap.config_reader`, it can
  add entries the file never holds. Bare imports are no longer reported there,
  and a generated `#` alias such as `#app/analytics/modal.js` is followed to
  the mapped asset whose logical path it names. Such a project's files import
  each other that way, so the chain from an entrypoint stopped at the first
  one, and the scripts and stylesheets under its templates and controllers
  were missing. Show diagnostics says what the import map is read from and
  which file names the service.

## 0.9.2

### Changed

- **The status bar stops once the tree is drawn.** It read "asking the
  Symfony console" until the console had answered and what was remembered
  had been confirmed, and nothing waits for either. The row in the tree says
  what is still being asked.
- **Show diagnostics says how long each console command took**, slowest
  first, and the project tooltip names the slowest, so a slow open can be
  read off rather than described.

## 0.9.1

The first open of a project no longer waits for Symfony.

### Fixed

- **Opening a project over a slow console.** The tree waited until every
  console command had answered or hit a fifteen-second cap, so on a remote
  machine six kernel boots at once timed out together, the project appeared
  late, and its routes, components and bundle namespaces came up as
  unavailable until a retry ran against the cache those boots had warmed. A
  project is now drawn as soon as its files are read, with what the console
  said the last time it was opened, and the console is asked after: an
  **Asking the Symfony console** row stands in until it answers, checks that
  need a current answer wait, and a command gets a minute rather than fifteen
  seconds. One that runs out of time says so instead of "Command failed". A
  trust prompt answered during the first read is no longer missed, and every
  workspace folder is drawn before any console is asked.

### Changed

- **Console answers are remembered between sessions**, command by command,
  in workspace state. Routes and components stand in from the last answer
  only until the console answers; namespaces keep falling back to it when
  the console fails, as before. The three configuration answers are kept for
  the first pass and confirmed after it, so a first open boots the kernel
  three times before anything is shown and three times after, and a
  configuration changed while the editor was closed is read again.
- **`var/` is excluded from the file watcher by default.** Symfony writes its
  cache there every time the console boots, and VS Code's own exclusions do
  not cover it. Set `"**/var/**": false` in `files.watcherExclude` to watch
  it again.

## 0.9.0

Routes, blocks and live components read from the template side, and a
binding that asks for something gets it written.

### Added

- **Route parameters.** A route now carries its placeholders, with the
  router's requirements and defaults. Inside `path()` and `url()`, and
  inside `redirectToRoute()` and `generateUrl()` in PHP, the keys complete;
  hover on the route lists its placeholders and hover on a key says what it
  fills. A call that names an unregistered route, or leaves out a placeholder
  its route requires, is reported under
  `wicker.diagnostics.missingRouteParameter`. A key the route does not
  declare is explained, not refused: Symfony appends it as a query string.
  In PHP the route name completes as well.
- **Twig blocks.** Go to Definition on a block name, or on `parent()` inside
  it, opens the block it overrides. Find All References lists every
  definition up and down the inheritance chain, and hover names the ancestor
  a block overrides and the templates overriding it. After `{% block`,
  completion offers the ancestors' names this template has not overridden.
  A top-level block no ancestor defines is reported under
  `wicker.diagnostics.unknownBlock`, because Twig renders nothing for it and
  says nothing. Blocks inside `{% embed %}` read against the embedded
  template, and `{% use %}` counts.
- **Live Components.** In the template of a component the console reports as
  live, `data-model` completes the props marked writable, past modifiers
  such as `on(change)|`, and `live_action()` completes the methods marked as
  actions. Hover says what a name is and Go to Definition opens its
  declaration. A missing prop or action, or a `data-model` on a prop that is
  not writable, is reported under `wicker.diagnostics.unknownLiveMember`.
- **Create and connect edits.** A missing outlet is declared like a missing
  target. A stub written into a TypeScript controller takes a typed event,
  and a controller created for an unregistered identifier is TypeScript when
  the project's controllers are. A relative import written without its
  extension is offered the one that exists. On a `data-controller`
  attribute, a refactoring connects the controller to another through an
  outlet, declaring it in the controller and binding it on the element in
  one edit.

## 0.8.0

A sidebar you can read at a glance and work from with the mouse, and a
faster extension underneath.

### Added

- **Rows are coloured by what they are.** Green for templates, purple for
  PHP, yellow for JavaScript, blue for TypeScript, cyan for API routes, orange
  for Stimulus, magenta for stylesheets, red for components.
  `wicker.sidebar.colors` turns it off; warnings keep their colour.
- **Right-click a row** to open its file to the side, reveal it in the
  Explorer, or copy what it names: a template's logical name, a route's name
  or path, a Stimulus controller's identifier.
- **The sidebar follows the active editor**, as the Explorer follows a file.
  `wicker.sidebar.autoReveal` turns that off.
- **Wicker: Go to Route** and **Wicker: Go to Template** in the Command
  Palette list every route with an action in the workspace, and every
  template by its logical name.
- **Git state on every row.** Folders, namespaces, routes and the project
  itself now carry their file or directory, so the editor's badges reach them
  as they already reached a controller.
- **A warning when the console cannot answer.** Routes, components and
  Stimulus controllers used to be silently absent; the tree now says what
  went unanswered, with the retry and settings actions the namespace warning
  has.
- **Show diagnostics** in the view's overflow menu.

### Changed

- **API routes lists JSON endpoints only.** A route that renders a template
  is a template route, whatever its path.
- **PHP rows wear PHP icons.** An action under its controller, and the row
  naming the controller under a template, keep the class and method glyphs;
  the leaf and the JSON object mark routes.
- **Less work on every keystroke, save and rebuild.** A document is re-parsed
  when typing pauses or a query asks, not at each key; a rebuild searches the
  workspace once; a template change asks the console nothing and a PHP change
  half of what it used to; reads over a remote connection are kept in flight.
- **Commands and providers exist before the first index is built**, so a
  hover or a palette command during the read of a large project answers with
  nothing instead of not existing.

### Fixed

- **A template name with a leading slash, or a `.` or `..` segment, is
  found**, not only accepted. 0.7.0 stopped the diagnostic refusing the name;
  the lookup still failed on it.
- **An `importmap.php` that could not be read** no longer marks every bare
  import in the project as missing.
- **Restricted Mode.** The extension runs in an untrusted workspace, without
  the console. Nothing had told VS Code so, and it disabled the extension
  outright.

## 0.7.0

What points at a file, and what a page actually runs.

### Added

- **A template says what points at it.** Which controller action renders it,
  which pages extend it, and which templates include it, each as rows under the
  template in the sidebar. An included row names the tag it was pulled in with,
  so an include, an embed and a macro import are told apart without opening the
  file.
- **Components and Stimulus controllers are browsable.** Both were already
  discovered and used for completion and hovers, and neither was listed
  anywhere. A component expands to the two files it is made of, which no single
  file names; a controller expands to the templates that mount it, or says
  Unused.
- **A page's Stimulus wiring sits under the template that mounts it.** Actions
  with the event that fires them, targets, values, classes, outlets and params.
  Selecting one opens the attribute itself, including where it is written in a
  layout rather than in the page.
- **`wicker.codeLens.enabled`** turns off the lenses above a template, and the
  lens now counts the templates extending a layout.

### Fixed

- **A template name starting with `/` is no longer reported as an error.**
  Twig's own loader trims leading slashes, so the file is found and only the
  diagnostic was wrong. Backslashes, doubled slashes and `..` now follow the
  rules Twig applies rather than being refused.
- **The tree's leaf icons draw over a remote connection.** An icon addressed by
  file URI is resolved against the window rather than the extension host, so
  over SSH it pointed at a path on the other machine and silently drew nothing.
- **A Stimulus controller declaring a `constructor` reported no targets, values
  or actions at all.** Bracket matching read its table as a plain object, so a
  token naming anything on `Object.prototype` was taken for an opening bracket
  and the matching never balanced again. `toString`, `valueOf` and
  `hasOwnProperty` did the same.
- **The hover names the event a `data-action` relies on** instead of calling it
  the element's default and leaving it to be looked up.

### Changed

- **Opening a project reads each file once.** Its PHP was read for render sites
  and again for the frontend index, and its templates for their contexts and
  again for the same index. Source maps are read only when a row asks about one.
- **The Controllers section no longer costs seconds to expand.** The controller
  list was regrouped and re-sorted from the whole PHP index on every call, then
  filtered by an ownership question asked once per controller. Two hundred
  controllers with four hundred actions measured 313ms and now measure 7ms.
- **Indexing costs less per file**, with PHP tokenised, JavaScript lexed and
  Twig regions marked once each rather than once per question. Grouping three
  thousand template names for the tree went from 49.8ms to 0.8ms, and deciding
  which project owns a file from 4.7us to 1.3us.

## 0.6.1

What a large project was waiting for.

### Fixed

- **The route sections no longer cost seconds.** Working out which files reach
  a route walked every indexed file once per route, and the Stimulus half
  walked them all again inside that. The sidebar ran it on every refresh, so a
  project with 2000 files and 200 routes measured 9.3 seconds. The same work
  now measures a millisecond.
- **A rebuild interrupted by an edit is no longer thrown away.** It restarted
  from nothing whenever a watched file changed while it ran, so where building
  takes seconds the next change usually arrived first and the index could stay
  empty for as long as someone kept working.
- **Generated trees stop triggering rebuilds.** A file appearing under `var`,
  `node_modules` or `.git` queued a full one. `vendor` is still watched, since
  bundle templates and packaged Stimulus controllers are indexed from there.
- **Hover, completion, definition and quick fixes reuse the parse** the index
  already made of that exact text instead of re-reading the document, and the
  scoped view of the index is kept until something can change it.
- **The index has a ceiling.** It held every file's text plus every parsed
  structure with no aggregate bound, roughly nine times the text it came from.
  It stops at the same 32MB the template context index has always used.

## 0.6.0

The connections Stimulus and AssetMapper make by naming convention alone.

### Added

- **Callbacks reach their declaration.** Nothing calls `urlValueChanged()` or
  `outputTargetConnected()`; Stimulus finds them by name because `url` and
  `output` are declared. Each now navigates to the declaration that causes it
  to run, and says that renaming one without the other stops it silently.
- **Stylesheets navigate.** `@import` and `url()` open what they point at,
  resolved relative to the stylesheet, with a bare specifier falling back to a
  logical asset path.
- **Action parameters are explained.** `data-<controller>-<name>-param` says
  what it becomes in the handler, `event.params.name`, and that the two names
  must simply agree because nothing declares them.

### Fixed

- An asset reference addressing part of a file resolves. `icons.svg#pin` names
  a symbol inside a mapped file and `f.woff2?v=2` busts a cache; matching
  either literally found nothing and made a working reference look broken.

## 0.5.0

Stimulus and AssetMapper, and the connections between them.

### Added

- **AssetMapper.** Configured roots, namespaces and exclusions read from the
  console and the asset map walked from them. `asset()` completes logical paths
  and opens the file behind one; `importmap()` completes entrypoints only.
- **Import specifiers** navigate in JavaScript and TypeScript, relative against
  the importing file and bare against `importmap.php`, which is where a `#`
  alias is declared. Unresolvable imports are reported, with each check
  suspended when the discovery it depends on is unavailable.
- **Stylesheets beneath a template**, found by whatever route reaches them: a
  direct `asset()` link, an importmap entrypoint, a Stimulus controller, and
  the `@import` chain of any stylesheet those lead to.
- **Stimulus CSS classes** end to end: `static classes`, the
  `data-<identifier>-<name>-class` attribute and the helper's class argument.
- **Action descriptors in full.** Events, key filters, `window` and `document`
  targets and action options all complete, not only the method.
- **Events between controllers.** `this.dispatch('changed')` is offered to a
  listener as `<identifier>:changed`, and the composed name opens the dispatch.
- **Generated members.** `statusUrlValue`, `hasBusyClass` and `outputTarget`
  complete after `this.` and lead back to the declaration they came from.
- **Value types and defaults**, shown wherever the value appears.
- **Outlets**: declarations, generated properties, callbacks, receiver methods,
  Twig bindings in every helper form, and Find All References across both.
- **Explanations in the project's own names.** A binding says which method an
  event calls and in which file. A binding that connects to nothing says which
  of the three ways it failed, since Stimulus reports none of them.
- **A quick fix that writes the missing member**, adding a method inside the
  class body or a name to its static list.
- Declared Stimulus members are coloured in JavaScript and TypeScript through a
  themeable `wicker.stimulusMember` colour.

### Fixed

- JSON endpoints appear under their controller in the sidebar. Action rows came
  from render sites alone, so an action returning JSON had no row at all while
  its route was listed under API routes.
- Route icons are decided in one place. The same route could be drawn as a
  globe in its section and a leaf under its controller, and the leaf claims a
  template is rendered.
- The Scripts group has an icon that exists. `code-block` is not a codicon, and
  `ThemeIcon` draws nothing for an unknown id without reporting a problem.

## 0.4.0

### Added

- Stimulus controller, action, target and value completion/navigation from Twig
  helpers and HTML attributes, using the project's runtime configuration and
  direct JavaScript/TypeScript declarations, including unsaved member edits.
- Route completion/navigation in Twig, fetch-to-controller/template navigation,
  Template routes and API routes in the sidebar, and Find All References for
  explicit Twig/JS consumers.
- JSON response field completion and declaration navigation in JavaScript and
  inline Twig scripts, following local awaited fetch/json assignments, literal
  PHP response arrays and Twig-supplied Stimulus URL values.
- Controller action rows show their HTTP method and URL first, keeping the PHP
  method name as secondary detail. Without route discovery, template targets
  provide context beside the method name.
- Distinct icons for each tree object type. Twig templates use a leaf, Twig
  routes use a leaf with a route arrow, and JSON routes use the object icon.
- Route rows sort by URL path in both route sections and under controllers.
- Controller dependencies link directly to project services, repositories,
  entities and other declared types, following unsaved source edits.
- Associated scripts beneath Twig templates and controllers, connected through
  Stimulus bindings, literal template relationships and route consumers. Local
  source maps let the tree prefer TypeScript over its generated JavaScript.

## 0.3.0

### Added

- Twig Component name completion, hover and navigation from HTML-like tags,
  `component()` and component tags, using Symfony's registered class/template
  pairs. Prop completion and navigation cover direct PHP properties, setters,
  mount parameters and anonymous `{% props %}`, including unsaved source edits.
- Twig local-variable completion and hover for assignments, loop bindings,
  macro parameters and literal `with` scopes. Literal includes and inheritance
  carry context across files, respecting `only`, overrides and project boundaries.
  Hover identifies possible PHP/Twig sources. Follows unsaved edits and file
  changes without adding unknown-variable diagnostics.
- Twig filter and function completion using the project's `debug:twig` output,
  including custom registrations. Hover shows discovered metadata and official
  references for standard names. Wildcard registrations resolve without being
  inserted as literal callable names.
- Unknown Twig filter/function warnings when discovery is fresh and complete,
  configurable through `wicker.diagnostics.unknownCallable`. Application PHP,
  configuration and dependency changes refresh discovery automatically. Warnings
  are suspended for unsaved project changes or unavailable/incomplete discovery.

### Fixed

- Rebuild again when a project change arrives during an in-flight refresh,
  preventing older discovery results from overwriting newer project state.

## 0.2.0

### Added

- Controllers and Templates sections in the Wicker sidebar. Expand controller
  actions to browse literal render targets, jump to PHP calls or attributes,
  and open their Twig files. Follows unsaved edits and shows unresolved targets.
- Twig variable completion and hover from literal controller context keys.
  Hover identifies each PHP source and explains when only some render calls
  supply a variable. Follows unsaved edits, respects local bindings and
  `wicker.enable`, and keeps nested workspace contexts separate.
- Wicker sidebar with a monochrome leaf Activity Bar icon. Browse templates by
  project, namespace and folder, see the namespace source, reveal the current template,
  refresh the index, and open Wicker settings. Includes empty and disabled states.
  Bundle namespaces are hidden by default, with a workspace-persistent toggle
  to show them. Application templates and overrides remain visible.
- "Rendered by" links above Twig templates jump to each PHP render call or
  `#[Template]` attribute that resolves to the file. Links follow unsaved PHP
  edits, file creation, changes, renames and deletion, and template overrides.
  They respect `wicker.enable` and VS Code's `editor.codeLens` setting.

### Removed

- Persistent Wicker status bar item. Namespace status and project details are
  available from the Wicker sidebar.

### Changed

- Hide minimap region headings in Twig by default. Folding markers for ordinary
  Twig blocks were producing oversized labels containing raw template syntax.
- Moved namespace source information into the project tooltip. Limited
  resolution shows a warning with Retry and Settings actions. The project
  context menu's Show diagnostics action opens a report for that project;
  normal tree rows no longer open Output.

## 0.1.1

### Fixed

- `wicker.enable` now works. It was declared in the settings but read by
  nothing, so turning Wicker off left every feature running. Setting it to
  false now silences navigation, hover, completion, colouring, quick fixes and
  diagnostics together, and hides the status bar item.

### Changed

- General PHP language support is no longer on the roadmap. VS Code selects a
  single provider for completion and for semantic tokens, so competing there
  with an established PHP extension either replaces a mature implementation or
  ships features that silently never run. Wicker stays on Symfony and Twig and
  expects to sit alongside a PHP extension.

## 0.1.0

First release. The bridge between a Symfony controller and the Twig template it
renders.

### Added

- **Go to definition** on every template name, from PHP and from Twig.
- **Hover** naming the resolved file, the kind of reference that reached it, and
  the variables the controller passes alongside.
- **Completion** of indexed template names inside the quotes.
- **Diagnostics** for a name that resolves to nothing, telling a missing file
  apart from an unregistered namespace, and staying silent on a name built at
  runtime.
- **Quick fix** creating the missing template, scaffolded and opened. It
  declines when the namespace is unregistered, since there is nowhere to put a
  file Twig could load.
- **Semantic colouring** of template names that resolve, so the references the
  extension understands are visible in the code rather than only on hover.
- **Twig syntax highlighting**, with HTML, JavaScript and CSS embedded.
- **Namespace resolution** from `bin/console debug:twig`, remembered so a
  stopped container does not lose it, falling back to
  `config/packages/twig.yaml` where no PHP is reachable at all.

References covered: `render()` and its siblings, `#[Template]`, and named
arguments in PHP; `extends`, `include`, `embed`, `use`, `import`, `from` and the
`include()` and `source()` functions in Twig.

### Notes

The extension ships no third-party runtime code. The Twig lexer, the PHP lexer
and the YAML reader were written for it.

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=WilliamSmithE.wicker),
or from the `.vsix` attached to the release.
