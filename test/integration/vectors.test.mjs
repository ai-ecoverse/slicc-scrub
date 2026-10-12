import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compile } from '../../dist/index.js';

const vectors = JSON.parse(readFileSync(new URL('../../vectors.json', import.meta.url), 'utf8'));
const encoder = new TextEncoder();

function bytesOf(text, hex) {
  return text === undefined ? Uint8Array.from(Buffer.from(hex, 'hex')) : encoder.encode(text);
}

function concat(parts) {
  return Uint8Array.from(Buffer.concat(parts.map((part) => Buffer.from(part))));
}

function sorted(hits) {
  return [...hits].sort((a, b) => `${a.name}${a.form}`.localeCompare(`${b.name}${b.form}`));
}

test('the vectors declare their thresholds', () => {
  assert.equal(vectors.format, 1);
  assert.equal(vectors.fragment, 16);
  assert.equal(vectors.minValue, 8);
  assert.equal(vectors.idleMs, 250);
  assert.ok(vectors.cases.length >= 30);
});

for (const vector of vectors.cases) {
  test(vector.name, () => {
    const scrubber = compile(vector.secrets);
    const input = bytesOf(vector.input, vector.inputHex);
    const output = bytesOf(vector.output, vector.outputHex);
    const whole = scrubber.bytes(input);
    assert.deepEqual(whole.bytes, output);
    assert.deepEqual(sorted(whole.hits), sorted(vector.hits));
    if (vector.input !== undefined) assert.equal(scrubber.text(vector.input).text, vector.output);
    for (let split = 0; split <= input.length; split++) {
      const stream = scrubber.stream();
      const out = concat([
        stream.push(input.subarray(0, split)),
        stream.push(input.subarray(split)),
        stream.end(),
      ]);
      assert.deepEqual(out, output, `split at ${split}`);
      assert.deepEqual(sorted(stream.hits), sorted(vector.hits), `hits split at ${split}`);
    }
    const stream = scrubber.stream();
    const parts = [...input].map((byte) => stream.push(Uint8Array.of(byte)));
    parts.push(stream.end());
    assert.deepEqual(concat(parts), output, 'one byte at a time');
  });
}
