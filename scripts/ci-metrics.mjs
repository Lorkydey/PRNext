import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

export function cacheHit(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    value === 'unknown'
  )
    return 'unknown';
  throw Error('Cache hits must be true, false, unknown or empty.');
}
const identifier = (value, fallback = 'unknown') => {
  if (value === undefined || value === '') return fallback;
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw Error('Invalid CI metric identifier.');
  return value;
};
export function metricRecord(options = {}, env = process.env) {
  const runId = env.GITHUB_RUN_ID || null,
    attempt = env.GITHUB_RUN_ATTEMPT || null;
  if (
    (runId !== null && !/^\d+$/.test(runId)) ||
    (attempt !== null && !/^[1-9]\d*$/.test(attempt))
  )
    throw Error('Invalid GitHub run identity.');
  const caches = {};
  for (const [name, value] of Object.entries(options.caches || {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name))
      throw Error('Invalid cache metric name.');
    caches[name] = cacheHit(value);
  }
  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    repository: identifier(env.GITHUB_REPOSITORY, null),
    runId,
    runAttempt: attempt === null ? null : Number(attempt),
    job: identifier(options.job || env.GITHUB_JOB),
    runner: identifier(options.runner || env.RUNNER_OS),
    suite: identifier(options.suite),
    shard: identifier(options.shard, 'all'),
    caches,
  };
}
export function validateMetric(record) {
  if (
    !record ||
    record.version !== 1 ||
    !record.caches ||
    typeof record.caches !== 'object' ||
    Array.isArray(record.caches)
  )
    throw Error('Unsupported CI metric record.');
  const expected = metricRecord(
    {
      job: record.job,
      runner: record.runner,
      suite: record.suite,
      shard: record.shard,
      caches: record.caches,
    },
    {
      GITHUB_REPOSITORY: record.repository ?? '',
      GITHUB_RUN_ID: record.runId ?? '',
      GITHUB_RUN_ATTEMPT:
        record.runAttempt == null ? '' : String(record.runAttempt),
    },
  );
  return {
    ...expected,
    recordedAt:
      typeof record.recordedAt === 'string' ? record.recordedAt : null,
  };
}
export async function recordMetric(args, env = process.env) {
  if (args[0] === 'record') args = args.slice(1);
  const options = { caches: {} };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index],
      value = args[index + 1];
    if (
      value === undefined ||
      ![
        '--runner',
        '--suite',
        '--shard',
        '--job',
        '--cache',
        '--output',
      ].includes(name)
    )
      throw Error(
        'Use record --suite NAME [--runner NAME] [--shard NAME] [--cache NAME=true|false|unknown] [--output FILE].',
      );
    if (name === '--cache') {
      const equal = value.indexOf('=');
      if (equal < 1) throw Error('Use --cache NAME=true|false|unknown.');
      const key = value.slice(0, equal);
      if (Object.hasOwn(options.caches, key))
        throw Error('Duplicate cache metric name.');
      options.caches[key] = value.slice(equal + 1);
    } else {
      const key = name.slice(2);
      if (Object.hasOwn(options, key)) throw Error('Duplicate metric option.');
      options[key] = value;
    }
  }
  if (!options.suite) throw Error('--suite is required.');
  const record = metricRecord(options, env),
    slug = (value) => value.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const output = path.resolve(
    options.output ||
      path.join(
        'artifacts/ci-metrics',
        `${slug(record.runner)}-${slug(record.suite)}-${slug(record.shard)}.json`,
      ),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(record, null, 2) + '\n', {
    flag: 'wx',
  });
  return output;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  recordMetric(process.argv.slice(2))
    .then(() => console.log('CI cache metric recorded.'))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
