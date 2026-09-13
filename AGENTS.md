Please adopt the following foundations into your context:

F:\GitHub\RIDM_Recursive_Invariant_Discovery_Model\RIDM.MD
F:\GitHub\AI_Best_Practices\docs\agentic_ai_programming_best_practices.md
F:\GitHub\AI_Best_Practices\docs\ai_smells_for_agents_to_avoid.md
F:\GitHub\AI_Best_Practices\docs\ui_ux_guidelines_for_agents.md

## Project: Wicker

A VS Code extension for Symfony and Twig. See README.md for what it does and
why. This section is the operational detail an agent needs before editing.

### Commands

    npm install        once, Node 20.19+
    npm run check      the gate: typecheck, lint, test. Run before reporting done.
    npm test           tests only
    npm run build      compile all packages
    npm run lint:fix   apply lint fixes

### Layout

    packages/core      the engine: no editor or protocol dependencies
    packages/server    LSP server over the engine (not started)
    packages/vscode    VS Code extension (not started)

Tests sit beside the code as `*.test.ts` and run under vitest. `tsconfig.json`
in each package type checks everything including tests; `tsconfig.build.json`
emits and excludes them.

### Conventions that are load-bearing

Paths inside the engine are project-relative and forward-slashed. Absolute
paths appear only as a project root. This is what keeps one index valid when
Symfony sees `/app` inside its container and the editor sees a Windows drive or
a WSL UNC path, so do not introduce absolute paths into the index.

Symfony's own `debug:*` commands are the preferred source of truth, and they
report loader paths relative to the project root. Treat their output as
untrusted: it is parsed defensively and a malformed payload degrades to a
fallback rather than throwing.

TypeScript 6 does not auto-discover hoisted `@types`, so `types` is declared
explicitly in `tsconfig.base.json`. Adding a package that contributes globals
means adding it there.

### Test environment

The live Symfony app used for verification is Symfony 8.1 on PHP 8.5 in Docker:

    source      /home/william/projects/symfonyApp   (WSL Ubuntu)
    from Windows  //wsl.localhost/Ubuntu/home/william/projects/symfonyApp
    container   symfonyapp-php-1, project mounted at /app

There is no PHP on the Windows host. Run console commands through the
container, for example:

    docker exec symfonyapp-php-1 php bin/console debug:twig --format=json
