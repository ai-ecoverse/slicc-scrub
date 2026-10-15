import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import yaml from 'js-yaml';

const dir = new URL('../../.github/workflows/', import.meta.url);
const RELEASING =
  /semantic-release|npm publish|npm\s+dist-tag|gh release|git tag|git push[^\n]*--tags/;
const MAIN = "github.ref == 'refs/heads/main'";

async function workflows() {
  const names = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name));
  return Promise.all(
    names.map(async (name) => ({
      name,
      doc: yaml.load(await readFile(new URL(name, dir), 'utf8')),
    }))
  );
}

const script = (job) =>
  (job.steps ?? []).map((step) => `${step.run ?? ''} ${step.uses ?? ''}`).join('\n');

test('only main releases: every job that publishes, tags or releases runs on main only', async () => {
  const seen = [];
  for (const { name, doc } of await workflows()) {
    for (const [id, job] of Object.entries(doc.jobs ?? {})) {
      if (!RELEASING.test(script(job))) continue;
      assert.equal(job.if, MAIN, `${name} ${id}`);
      seen.push(`${name}:${id}`);
    }
  }
  assert.deepEqual(seen, ['release.yml:release']);
});

test('the release workflow can still be dispatched, but only main gets past its guard', async () => {
  const release = (await workflows()).find((w) => w.name === 'release.yml').doc;
  assert.ok('workflow_dispatch' in release.on);
  assert.deepEqual(release.on.push, { branches: ['main'] });
  assert.equal(release.jobs.release.if, MAIN);
});
