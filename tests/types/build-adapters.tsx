import { build, buildStatic, readBuildOutput, validateBuildOutput } from '@thomas.f/prnext';
import type { BuildOutput, StaticBuildResult } from '@thomas.f/prnext';

const staticResult: Promise<StaticBuildResult> = build('/project', { adapter: 'static', from: 'dist', spa: true });
build('/project', { adapter: 'react', dev: true });
buildStatic('/project', { from: 'dist', distDir: 'build/prnext' });
const output: Promise<BuildOutput> = readBuildOutput('/project/.prnext');
const validated = validateBuildOutput({});
if (validated.adapter === 'static') {
  const server: null = validated.server;
  const fallback: null | 'index.html' = validated.fallback;
  void server; void fallback;
} else {
  const worker: 'runtime/worker.mjs' = validated.server.entry;
  void worker;
}
// @ts-expect-error No generic Node SSR adapter exists yet.
build('/project', { adapter: 'node' });
// @ts-expect-error Importing static output is a production-only operation.
buildStatic('/project', { dev: true });
// @ts-expect-error React builds do not use an imported browser directory.
build('/project', { adapter: 'react', from: 'dist' });
void staticResult; void output;
