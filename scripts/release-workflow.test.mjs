import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = (await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

// These checks lock the reviewed workflow's small, explicit structure. They are
// not a YAML parser; actionlint separately validates GitHub Actions syntax.
function block(source, key, indentation = 0) {
  const lines = source.split('\n');
  const heading = `${' '.repeat(indentation)}${key}:`;
  const starts = lines.flatMap((line, index) => line === heading ? [index] : []);
  assert.equal(starts.length, 1, `Expected one ${heading.trim()} block`);
  const start = starts[0];
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !line.trimStart().startsWith('#') && line.search(/\S/) <= indentation) break;
    end++;
  }
  return lines.slice(start, end).join('\n');
}

function permissions(source, indentation) {
  const text = block(source, 'permissions', indentation);
  const result = {};
  for (const line of text.split('\n').slice(1).filter(line => line.trim())) {
    const match = line.match(new RegExp(`^ {${indentation + 2}}([a-z-]+): (read|write|none)$`));
    assert.ok(match, `Permissions must be explicit: ${line.trim()}`);
    assert.ok(!Object.hasOwn(result, match[1]), 'Duplicate permission');
    result[match[1]] = match[2];
  }
  return result;
}

function runBlocks(source) {
  const lines = source.split('\n');
  const result = [];
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s+(?:- )?run:/.test(lines[index])) continue;
    const indentation = lines[index].search(/\S/);
    let end = index + 1;
    while (end < lines.length && (!lines[end].trim() || lines[end].search(/\S/) > indentation)) end++;
    result.push(lines.slice(index, end).join('\n'));
    index = end - 1;
  }
  return result;
}

function assertTriggerAndInputs(source) {
  const triggers = block(source, 'on');
  assert.deepEqual([...triggers.matchAll(/^  ([a-z_]+):$/gm)].map(match => match[1]), ['workflow_dispatch']);
  const inputs = block(triggers, 'inputs', 4);
  const names = [...inputs.matchAll(/^      ([a-z_]+):$/gm)].map(match => match[1]);
  assert.deepEqual(names, ['version', 'source_sha', 'release_commit', 'ci_run_id', 'artifact_run_id', 'performance_run_id', 'dry_run']);
  for (const name of names) {
    const input = block(inputs, name, 6);
    assert.match(input, /^        required: true$/m, `${name} is required`);
    assert.match(input, new RegExp(`^        type: ${name === 'dry_run' ? 'boolean' : 'string'}$`, 'm'));
  }
  assert.match(block(inputs, 'dry_run', 6), /^        default: true$/m, 'A manual run must default to read-only qualification');
  const concurrency = block(source, 'concurrency');
  assert.match(concurrency, /^  group: prnext-npm-release$/m);
  assert.match(concurrency, /^  cancel-in-progress: false$/m, 'An active publication must not be automatically canceled');
}

function assertJobPermissions(source) {
  assert.deepEqual(permissions(source, 0), { contents: 'read' });
  const jobs = block(source, 'jobs');
  assert.deepEqual([...jobs.matchAll(/^  ([a-z_]+):$/gm)].map(match => match[1]), ['qualify', 'publish', 'finalize']);
  const qualify = block(jobs, 'qualify', 2);
  const publish = block(jobs, 'publish', 2);
  const finalize = block(jobs, 'finalize', 2);
  assert.deepEqual(permissions(qualify, 4), { contents: 'read', actions: 'read' });
  assert.deepEqual(permissions(publish, 4), { contents: 'read', actions: 'read', 'id-token': 'write' });
  assert.deepEqual(permissions(finalize, 4), { contents: 'write', actions: 'read' });
  assert.equal([...source.matchAll(/^\s+id-token: write$/gm)].length, 1);
  assert.equal([...source.matchAll(/^\s+environment:/gm)].length, 1, 'Exactly one job may request the release approval');
  assert.match(block(publish, 'environment', 4), /^      name: npm-release$/m);
  for (const job of [qualify, publish, finalize]) {
    assert.match(job, /^    runs-on: ubuntu-24\.04$/m, 'Release work must use a standard GitHub-hosted runner');
    assert.doesNotMatch(job, /\bmatrix\s*:/, 'Publishing must not expand to several independently approved jobs');
  }
  assert.match(qualify, /if:.*github\.repository == 'Lorkydey\/PRNext'.*github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /if:.*!inputs\.dry_run.*github\.repository == 'Lorkydey\/PRNext'.*github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /^    needs: qualify$/m);
  assert.match(finalize, /^    needs: \[qualify, publish\]$/m);
  assert.match(finalize, /if:.*!inputs\.dry_run.*needs\.publish\.result == 'success'/);
}

function assertNoShellInjectionOrCredentials(source) {
  for (const run of runBlocks(source)) {
    assert.doesNotMatch(run, /\$\{\{/, 'Expressions must enter shell commands through environment values, not source interpolation');
  }
  const qualify = block(block(source, 'jobs'), 'qualify', 2);
  const mapping = {
    RELEASE_VERSION: 'version',
    RELEASE_SOURCE: 'source_sha',
    RELEASE_COMMIT: 'release_commit',
    RELEASE_CI_RUN: 'ci_run_id',
    RELEASE_ARTIFACT_RUN: 'artifact_run_id',
    RELEASE_PERFORMANCE_RUN: 'performance_run_id',
  };
  for (const [variable, input] of Object.entries(mapping)) {
    assert.ok(qualify.includes(variable + ': ${{ inputs.' + input + ' }}'), `Missing safe environment mapping for ${input}`);
    assert.ok(runBlocks(qualify).some(run => run.includes(`"$${variable}"`)), `The ${input} argument must be quoted`);
  }
  assert.doesNotMatch(source, /secrets\s*[.\[]|NODE_AUTH_TOKEN|NPM_TOKEN|NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG)|npm\s+(?:login|adduser)|--(?:otp|token)\b/i, 'No credential or token fallback is allowed');
  const jobs = block(source, 'jobs');
  for (const name of ['publish', 'finalize']) {
    const job = block(jobs, name, 2);
    assert.doesNotMatch(job, /npm\s+(?:ci|install|i|exec)|\bnpx\s/, 'Privileged jobs must not install dependencies or execute fetched package commands');
    assert.match(job, /^          persist-credentials: false$/m);
  }
}

function assertArtifactAndClientContract(source) {
  for (const line of source.split('\n').filter(line => /^\s+(?:- )?uses:/.test(line))) {
    assert.match(line, /^\s+(?:- )?uses: actions\/[a-z-]+@[a-f0-9]{40}(?:\s+#.*)?$/, 'Actions must be official and pinned to a full commit');
  }
  assert.equal([...source.matchAll(/persist-credentials: false/g)].length, 3);
  assert.equal([...source.matchAll(/ref: \$\{\{ github\.sha \}\}/g)].length, 3, 'Helpers must come from the dispatched main commit');
  const jobs = block(source, 'jobs');
  const qualify = block(jobs, 'qualify', 2);
  const publish = block(jobs, 'publish', 2);
  const finalize = block(jobs, 'finalize', 2);
  assert.ok(qualify.includes('plan_sha256: ${{ steps.plan.outputs.sha256 }}'));
  assert.ok(qualify.includes('artifact_name: qualified-release-${{ github.run_id }}-${{ github.run_attempt }}'));
  assert.ok(qualify.includes('name: qualified-release-${{ github.run_id }}-${{ github.run_attempt }}'));
  assert.match(qualify, /run: node scripts\/release-plan-summary\.mjs/);
  assert.match(qualify, /run: npm ci --ignore-scripts --no-audit --no-fund/);
  for (const job of [publish, finalize]) {
    assert.ok(job.includes('name: ${{ needs.qualify.outputs.artifact_name }}'));
    assert.ok(job.includes('RELEASE_PLAN_SHA256: ${{ needs.qualify.outputs.plan_sha256 }}'));
    assert.ok(runBlocks(job).some(run => run.includes('--plan-sha256 "$RELEASE_PLAN_SHA256"')), 'Both privileged jobs must verify the sealed plan');
  }
  assert.match(publish, /run: node scripts\/release-npm-cli\.mjs/);
  assert.match(publish, /node scripts\/release-publish\.mjs/);
  assert.ok(publish.includes('--npm-cli "$RELEASE_NPM_CLI"'));
  assert.ok(publish.includes('artifact_name: release-publication-${{ github.run_id }}-${{ github.run_attempt }}'));
  assert.ok(publish.includes('name: release-publication-${{ github.run_id }}-${{ github.run_attempt }}'));
  assert.match(publish, /name: Preserve the publication result\n\s+if: always\(\)/);
  assert.ok(finalize.includes('name: ${{ needs.publish.outputs.artifact_name }}'));
  assert.match(finalize, /node scripts\/release-finalize\.mjs/);
  assert.ok(finalize.includes('--verification "$RUNNER_TEMP/publication/registry-verification.json"'));
}

function assertNewDispatchGuard(source) {
  const publish = block(block(source, 'jobs'), 'publish', 2);
  const heading = '      - name: Require a newly qualified dispatch';
  assert.equal(publish.split(heading).length - 1, 1, 'A separate rerun guard must run before the publisher step');
  const guard = publish.indexOf(heading);
  const bootstrap = publish.indexOf('      - name: Prepare the pinned npm client');
  const upload = publish.indexOf('      - name: Publish exact archives and verify both tags');
  assert.ok(guard >= 0 && guard < bootstrap && bootstrap < upload, 'Reruns must fail before bootstrap and the historically tracked publish step');
  const code = publish.slice(guard, bootstrap);
  assert.match(code, /if \(process\.env\.GITHUB_RUN_ATTEMPT !== "1"\) throw new Error\(/);
  assert.doesNotMatch(code, /^\s+(?:if|continue-on-error):/m, 'The rerun guard must not be skipped or ignored');
}

test('release workflow keeps dispatch inputs, safe defaults and a non-canceling release lock', () => {
  assertTriggerAndInputs(workflow);
});

test('one approved cloud job owns OIDC and only finalization receives content write', () => {
  assertJobPermissions(workflow);
});

test('release inputs are quoted environment data and privileged jobs have no dependency or credential fallback', () => {
  assertNoShellInjectionOrCredentials(workflow);
});

test('reviewed actions, exact plan digest and publication receipt cross the job boundaries', () => {
  assertArtifactAndClientContract(workflow);
  assertNewDispatchGuard(workflow);
});

test('workflow checks reject automatic release triggers, unsafe defaults and cancellation', () => {
  for (const change of [
    source => source.replace('on:\n', 'on:\n  push:\n'),
    source => source.replace('default: true', 'default: false'),
    source => source.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
  ]) assert.throws(() => assertTriggerAndInputs(change(workflow)));
});

test('workflow checks reject permission broadening and a second release environment', () => {
  for (const change of [
    source => source.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
    source => source.replace('      actions: read', '      actions: write'),
    source => source.replace('  finalize:\n', '  finalize:\n    environment:\n      name: npm-release\n'),
    source => source.replace("github.ref == 'refs/heads/main'", "github.ref != 'refs/heads/main'"),
  ]) assert.throws(() => assertJobPermissions(change(workflow)));
});

test('workflow checks reject shell interpolation, npm tokens and privileged dependency installation', () => {
  for (const change of [
    source => source.replace('--version "$RELEASE_VERSION"', '--version "${{ inputs.version }}"'),
    source => source.replace('          RELEASE_NPM_CLI:', '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n          RELEASE_NPM_CLI:'),
    source => source.replace('  publish:\n', '  publish:\n    steps:\n      - run: npm ci\n'),
  ]) assert.throws(() => assertNoShellInjectionOrCredentials(change(workflow)));
});

test('workflow checks reject moving action tags, an unsealed plan and missing publication receipts', () => {
  for (const change of [
    source => source.replace(/actions\/checkout@[a-f0-9]{40}/, 'actions/checkout@v7'),
    source => source.replaceAll('--plan-sha256 "$RELEASE_PLAN_SHA256"', '--plan-sha256 "different"'),
    source => source.replaceAll('name: release-publication-${{ github.run_id }}', 'name: other-publication'),
    source => source.replaceAll('name: ${{ needs.qualify.outputs.artifact_name }}', 'name: qualified-release-${{ github.run_id }}-${{ github.run_attempt }}'),
  ]) assert.throws(() => assertArtifactAndClientContract(change(workflow)));
});

test('a removed, moved or inverted rerun guard cannot expose the real publisher step', () => {
  const match = workflow.match(/^      - name: Require a newly qualified dispatch\n[\s\S]*?(?=^      - )/m);
  assert.ok(match);
  const guard = match[0];
  for (const changed of [
    workflow.replace(guard, ''),
    workflow.replace(guard, '').replace('      - name: Preserve the publication result', guard + '      - name: Preserve the publication result'),
    workflow.replace('GITHUB_RUN_ATTEMPT !== "1"', 'GITHUB_RUN_ATTEMPT === "1"'),
  ]) assert.throws(() => assertNewDispatchGuard(changed));
});
