# Next sprint: Stimulus and AssetMapper

Status: in progress after v0.4.0. The first outlet increment is implemented in
the development checkout. It is not a marketplace release, and the remaining
sprint scope below is still outstanding.

## Development progress

The first increment covers direct static outlet declarations, namespaced
generated properties, callback navigation and direct receiving-controller
method completion/navigation. Twig supports literal outlet attributes and
StimulusBundle positional, named and chained-filter arguments. Hover explains
targets versus outlets, page-wide selectors and optional presence checks.
Find All References links a declaration to its Twig bindings and JS/TS uses.
Associated scripts include the receiving controller with an outlet reason.

Verified with core and real VS Code provider tests: exact replacement ranges,
JS/TS completion coexistence, unsaved receiver edits, deleted receiver files,
disabled Wicker and nested-project isolation. The live app includes
`templates/wicker/outlets.html.twig`, `wicker_outlet_controller.js` and
`wicker_counter_controller.js`; `/wicker` renders a sender and a separate counter.
Its functional test checks that the selector points outside the sender's scope.

Still to implement for outlets: evidence-backed selector matches/completion,
a combined declaration-and-binding connect edit, callback insertion, inherited
declarations and member access through outlet callback parameters/aliases.
CSS selector expressions remain runtime relationships; this increment does not
claim to know which elements exist in the rendered page. AssetMapper and the
other Stimulus coverage rows have not been implemented in this increment.

## Outcome

A developer encountering Stimulus and AssetMapper for the first time can
understand an existing page, add behavior, connect controllers, load an asset,
and fix a broken connection without memorizing framework syntax or searching
through unrelated files. Serve experienced developers through the same fast,
quiet interactions. Initial environment setup remains outside this sprint.

The user asked for full Stimulus and AssetMapper coverage, including outlets,
with low cognitive load. Audit the public reference systematically. Do not
stop after extending the existing names-only completion. For each concept,
record what is implemented, demonstrated and verified, and what depends on
runtime information. Uncertainty needs a useful explanation rather than a
guessed relationship or a speculative warning.

## Coverage and delivery order

Ship coherent steps in this order, with each built and opened for live testing.
The whole list is the sprint scope; completing the first step does not complete
the sprint.

### 1. Outlets and understandable connections

- Parse outlet declarations and their generated properties/callbacks, including
  namespaced controller identifiers. Connect the declaring controller, its Twig
  binding, the referenced controller and its source members.
- Support literal HTML outlet attributes and StimulusBundle helper arguments,
  including named arguments and chained filters.
- Complete outlet names, navigate declarations and find usages in both
  directions. Explain the selector and show known matching controller elements
  where source evidence supports them. Do not claim that a source template is
  the rendered DOM or that selectors can only reach descendants.
- Teach the distinction in context: a target is an element in a controller's
  scope; an outlet is another controller instance selected on the page. Explain
  the presence check before accessing an optional outlet. Link short explanations
  to the relevant project declarations and official reference.
- Offer a concrete edit to connect existing controllers. Preview changes to the
  declaration and Twig binding together; preserve JS/TS style and user code.

Reference: [Stimulus outlets](https://stimulus.hotwired.dev/reference/outlets).

### 2. Complete the Stimulus editing experience

| Area | Expected editor assistance |
| --- | --- |
| Controllers and scope | Registration origin, identifiers, nested and multiple scopes, connection lifecycle, locally traceable inheritance and registrations. |
| Actions | Events and shorthand, keyboard filters/modifiers, window/document listeners, options, ordering and action parameters. Explain the actual event-to-method connection. |
| Targets | Singular/plural access, presence checks, scope and connected/disconnected callbacks; navigate between declarations and bindings. |
| Values | Types, defaults, serialization, generated properties, presence checks and change callbacks. Show the configured value when it is statically known. |
| CSS classes | Logical class names, mapped classes, singular/plural access and presence checks, distinct from arbitrary CSS class completion. |
| Outlets | Declarations, selectors, generated accessors, callbacks, related controllers and optional access. |
| Events between controllers | Literal dispatch names and receiving actions, event detail where traceable, bubbling/global listeners, explanation of when events fit. |
| JavaScript and TypeScript | Completion/navigation for generated Stimulus members without breaking built-in JS/TS assistance; declaration snippets and original-source navigation. |
| Symfony integration | Functions, filters, named/positional helper arguments, enabled UX controllers, eager/lazy loading and registration origins. |

References: [controllers](https://stimulus.hotwired.dev/reference/controllers),
[lifecycle](https://stimulus.hotwired.dev/reference/lifecycle-callbacks),
[actions](https://stimulus.hotwired.dev/reference/actions),
[targets](https://stimulus.hotwired.dev/reference/targets),
[values](https://stimulus.hotwired.dev/reference/values),
[CSS classes](https://stimulus.hotwired.dev/reference/css-classes),
[TypeScript](https://stimulus.hotwired.dev/reference/using-typescript), and
[StimulusBundle](https://symfony.com/bundles/StimulusBundle/current/index.html).

### 3. AssetMapper from template to browser

- Discover configured asset roots, namespaces, exclusions, bundle assets and
  overrides. Complete logical asset names in Twig and open their actual source.
- Connect import-map keys and entrypoints to local files or declared package
  destinations. Complete and navigate `asset()`, `importmap()`, relative/bare
  imports, literal dynamic imports and page-specific entrypoints.
- Cover JavaScript, CSS, images, fonts and JSON assets, including CSS imports
  and URLs. Show original TypeScript/CSS sources when the project's installed
  build integration supplies reliable mapping.
- Make the loading chain explorable: template → entrypoint → imported files →
  Stimulus registration. Explain why an asset is associated with this page and
  distinguish direct use from a transitive import or a shared layout.
- Explain logical paths versus generated URLs, development serving versus
  compiled production assets, missing imports and stale compiled output.
- Provide contextual repair actions for known missing references and missing
  local import-map entries. Package commands must use real installed tooling;
  dependency changes need a concrete package/version and reviewable effects.

Reference: [Symfony AssetMapper](https://symfony.com/doc/current/frontend/asset_mapper.html).

### 4. Ergonomics, repairs and a beginner walkthrough

- Completion should say what an item does, show a tiny relevant example and
  insert valid syntax at the cursor. Keep the first line short; expand detail
  only when requested.
- Hover answers “what is this?”, “what does it connect to?” and “where do I
  change it?” using this project's names. Explain an action such as
  `click->cart#add` as “Clicking this element calls add() in cart_controller.js.”
- An “Explain this connection” action follows the same model for bindings,
  outlets and asset imports, with navigable sources and a brief reason for an
  unresolved link. Do not require a separate tutorial panel to do normal work.
- Offer focused create/connect/repair actions from the selected code: add a
  missing method, declare a member, bind an outlet, create a controller, or
  register an existing local entrypoint. Use native edits and previews, with
  normal undo for reversible source changes.
- Keep the tree relevant to the current objects. Use consistent type icons and
  relationship labels; avoid expanding every dependency into an enormous tree.
- Build a small working tour in the existing demo: a controller controls its
  own target, reads a typed value, uses a CSS class, calls an outlet, dispatches
  an event, and loads page-specific assets. Include a few deliberate mistakes
  that Wicker can explain and repair. Keep it usable by keyboard.

## Starting point and technical constraints

v0.4.0 already supports basic controller/action/target/value references in Twig,
direct Stimulus declarations, registered identifiers, associated script lists,
route/API connections and single-source TS preference from local source maps.
Outlets, CSS class bindings, action descriptor assistance, generated-member
intelligence and AssetMapper discovery/navigation are gaps.

The current live app is Symfony 8.1 with StimulusBundle 3.4. Verified locally:
`debug:asset-map` exposes a table with `--full`, extension and vendor filters,
but no JSON option. `debug:config framework asset_mapper --format=json` reports
runtime configuration. `importmap:require` supports local paths, entrypoints
and dry runs. Recheck installed versions while implementing; do not invent a
`debug:stimulus` or JSON asset-map command.

Use Symfony discovery as authority and parse its output defensively. Preserve
project-relative paths, session ownership, unsaved buffers and wicker.enable.
Keep all runtime code first-party. Do not execute arbitrary JS/PHP to infer
types, follow remote imports automatically, or run asset-map:compile in the live
development app. Custom schemas, computed registrations and arbitrary rendered
DOM relationships need explicit handling or an honest unknown state.

## Completion criteria

- Every coverage row has a documented status and an editor-driven test or a
  concrete explanation of why the relationship requires runtime evidence.
- A beginner can follow the live tour, explain target versus outlet and logical
  asset versus entrypoint, add one behavior and repair the deliberate mistakes.
- Navigation, references, completions and tree nodes agree about the same
  connection. Save, rename, delete, unsaved edit and undo refresh them correctly.
- JS/TS provider coexistence, nested projects, disabled Wicker, unavailable
  console discovery, dynamic expressions and malformed output are exercised.
- Light/dark themes, keyboard navigation, short labels and a larger fixture are
  checked. Keep repeat console calls and source parsing out of keystroke paths.
- Build, typecheck, lint, unit and real VS Code integration tests pass; each
  completed implementation step is launched against the real Symfony app for
  the user's live check. Update README and CHANGELOG only for shipped behavior.
