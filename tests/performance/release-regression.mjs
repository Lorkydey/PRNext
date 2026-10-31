import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkReleaseRegression } from './release-regression-check.mjs';
import {isMainModule} from '../../scripts/main-module.mjs';
export { checkReleaseRegression, median, medianInterval, releaseRoutes, validateReleaseBudgets } from './release-regression-check.mjs';

if (isMainModule(import.meta.url)) {
  const [command, filename, output] = process.argv.slice(2);
  if (command === 'check' && filename && !output) {
    const result = checkReleaseRegression(JSON.parse(await readFile(filename, 'utf8')));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
  } else if (command === 'run' && filename && output) {
    const { runReleaseRegression } = await import('./release-regression-runner.mjs');
    const report = await runReleaseRegression(JSON.parse(await readFile(filename, 'utf8')), { configurationDirectory: path.dirname(path.resolve(filename)) });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report.gate, null, 2));
    if (report.gate.status !== 'passed') process.exitCode = 1;
  } else throw new Error('Use release-regression.mjs run <config.json> <new-report.json> or check <report.json>.');
}
