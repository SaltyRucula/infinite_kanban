#!/usr/bin/env node
/**
 * Bundles the worker CLI into a self-contained set of ESM outputs so the
 * package can be published and installed standalone (npx agentboard-worker).
 *
 * The three private, unpublished workspace packages this package depends on
 * at the source level — @ai-agent-board/shared, @ai-agent-board/a2a and
 * @ai-agent-board/opencode-compat — are inlined into the bundle. Genuine npm
 * dependencies stay external (imported, not bundled) so they are resolved
 * from node_modules at install time, the same as any other published
 * package's runtime dependencies.
 *
 * Run after `tsc -b tsconfig.build.json`, which only emits declaration files
 * for this package (see tsconfig.build.json's emitDeclarationOnly) — every
 * runtime .js file in dist/ comes from this script, so none of them can
 * retain a raw `@ai-agent-board/*` import specifier.
 */
import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Real npm dependencies: keep external and declared in package.json
// "dependencies" so they resolve normally from the installer's node_modules.
// The trailing "/*" entries cover subpath imports (e.g. "@a2a-js/sdk/errors",
// "@codewithdan/agent-sdk-core/providers").
const EXTERNAL = [
  '@a2a-js/sdk',
  '@a2a-js/sdk/*',
  '@codewithdan/agent-sdk-core',
  '@codewithdan/agent-sdk-core/*',
  '@opencode-ai/sdk',
  '@openai/codex-sdk',
  'express',
  'uuid',
];

await build({
  absWorkingDir: packageDir,
  // a2a-server.ts and execution-endpoint.ts are separate entries (not just
  // cli.ts) because: (1) cli.ts reaches a2a-server.ts only through a dynamic
  // `await import('./a2a-server.js')`, which code splitting keeps lazy rather
  // than inlined into the always-loaded cli.js; (2) execution-endpoint.js is
  // imported directly (outside the bin) by scripts/demo-board-a2a.mjs, which
  // expects it to keep working as a standalone, dependency-free module.
  entryPoints: ['src/cli.ts', 'src/a2a-server.ts', 'src/execution-endpoint.ts'],
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: EXTERNAL,
  logLevel: 'info',
});

// esbuild does not carry over the source file's executable bit, and npm pack
// only preserves modes that are already set on disk, so the shipped bin must
// be marked executable explicitly or `npx`/direct invocation cannot run it.
await chmod(path.join(packageDir, 'dist', 'cli.js'), 0o755);
