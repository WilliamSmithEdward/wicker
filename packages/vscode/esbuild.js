/**
 * Bundles the extension into a single CommonJS file.
 *
 * The engine and its dependencies are bundled rather than shipped as
 * node_modules: @wicker/core is a workspace package that is never published, so
 * a consumer of the .vsix has no other way to get it.
 */
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Reports build failures with file and line, which esbuild omits by default. */
const problemReporter = {
  name: 'problem-reporter',
  setup(build) {
    build.onEnd((result) => {
      for (const error of result.errors) {
        const where = error.location;
        console.error(
          where === null || where === undefined
            ? `error: ${error.text}`
            : `error: ${error.text}\n    at ${where.file}:${where.line}:${where.column}`,
        );
      }
      console.log(`[${new Date().toLocaleTimeString()}] build ${result.errors.length === 0 ? 'succeeded' : 'failed'}`);
    });
  },
};

async function main() {
  const context = await esbuild.context({
    entryPoints: ['src/extension.ts', 'src/test/extension.test.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outdir: 'out',
    // Both are supplied by the host at runtime: `vscode` by the editor, and
    // `mocha` by the integration test runner. Bundling either would break it.
    external: ['vscode', 'mocha'],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'silent',
    plugins: [problemReporter],
  });

  if (watch) {
    await context.watch();
  } else {
    await context.rebuild();
    await context.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
