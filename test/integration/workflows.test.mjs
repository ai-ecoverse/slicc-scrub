import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { load } from 'js-yaml';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const text = await read('.github/workflows/ci.yml');
const ci = load(text);
const pkg = JSON.parse(await read('package.json'));
const version = pkg.devDependencies['@ai-ecoverse/slicc-shared-web'];

test('CI is one caller of slicc-shared-web pipeline.yml, at the devDependency version', async () => {
  assert.deepEqual(await readdir(new URL('../../.github/', import.meta.url)), ['workflows']);
  assert.deepEqual(await readdir(new URL('../../.github/workflows/', import.meta.url)), ['ci.yml']);
  assert.match(version, /^2\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(ci.jobs), ['ci']);
  assert.equal(
    ci.jobs.ci.uses,
    `ai-ecoverse/slicc-shared-web/.github/workflows/pipeline.yml@v${version}`
  );
  assert.equal(ci.jobs.ci.secrets, 'inherit');
  assert.match(pkg.devDependencies['@ai-ecoverse/slicc-cdp'], /^\d+\.\d+\.\d+$/);
});

test('CI runs on pull requests, merge groups and pushes to main, and cancels only a superseded pull request run', () => {
  assert.deepEqual(ci.on, { pull_request: null, merge_group: null, push: { branches: ['main'] } });
  assert.deepEqual(ci.concurrency, {
    group: 'ci-${{ github.ref }}',
    'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
  });
  assert.deepEqual(ci.permissions, {
    contents: 'write',
    actions: 'read',
    issues: 'write',
    'pull-requests': 'write',
    statuses: 'write',
    'id-token': 'write',
    attestations: 'write',
  });
});

test('the pipeline picks its runners, and nothing deploys or runs after a release', () => {
  const inputs = ci.jobs.ci.with;
  for (const name of ['runs-on', 'after-release', 'release-environment', 'deploy', 'test']) {
    assert.equal(inputs[name], undefined, name);
  }
  assert.doesNotMatch(text, /vars\.|runs-on|workflow_dispatch|schedule:|workflow_run/);
});

test('the shard runs exactly the files npm test runs, on Node 26', () => {
  const inputs = ci.jobs.ci.with;
  assert.equal(inputs['test-glob'], 'test/integration/*.test.mjs');
  assert.ok(pkg.scripts.test.endsWith(` '${inputs['test-glob']}'`), pkg.scripts.test);
  assert.doesNotMatch(pkg.scripts.test, /NODE_OPTIONS/);
  assert.equal(inputs['node-version'], '26');
  assert.equal(inputs.shards, 1);
});

test('semantic-release publishes to npm from main, from the trusted ci.yml, with provenance', async () => {
  assert.equal(pkg.fledgling.workflow, 'ci.yml');
  assert.equal(pkg.fledgling.repo, 'ai-ecoverse/slicc-scrub');
  assert.equal(pkg.publishConfig.provenance, true);
  const { default: release } = await import('../../release.config.mjs');
  assert.deepEqual(release.branches, ['main']);
  assert.ok(release.plugins.includes('@semantic-release/npm'));
  assert.doesNotMatch(JSON.stringify(release), /npmPublish/);
});

test('the hooks fail closed and are installed per worktree', async () => {
  assert.equal(pkg.scripts.prepare, 'slicc-install-hooks');
  const hooks = load(await read('lefthook.yml'));
  assert.equal(hooks.assert_lefthook_installed, true);
  assert.deepEqual(hooks.extends, ['node_modules/@ai-ecoverse/slicc-shared-web/lefthook.yml']);
  assert.equal(hooks['pre-commit'].jobs[0].name, 'shared hooks');
  assert.match(await read('.githooks/pre-commit'), /node_modules\/\.git-hooks\//);
});
