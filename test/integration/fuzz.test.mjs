import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from '../../dist/index.js';

let seed = 0x5eed;
function random() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (list) => list[Math.floor(random() * list.length)];
const ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=_-.:@ "\'&<>é✓\n';

function word(min, max) {
  const length = min + Math.floor(random() * (max - min + 1));
  let out = '';
  for (let i = 0; i < length; i++) out += pick([...ALPHABET]);
  return out;
}

function value() {
  let out = '';
  while (new TextEncoder().encode(out).length < 8) out = word(8, 48).replace(/[\n]/g, 'n');
  return out;
}

const encodings = [
  (v) => v,
  (v) => JSON.stringify(v).slice(1, -1),
  (v) => encodeURIComponent(v),
  (v) => Buffer.from(v).toString('base64'),
  (v) => Buffer.from(v).toString('base64url'),
  (v) => Buffer.from(v).toString('hex'),
  (v) =>
    Buffer.from(v)
      .toString('base64')
      .replace(/(.{12})/g, '$1\n'),
];

function forms(v) {
  const out = encodings.slice(0, 6).map((encode) => Buffer.from(encode(v)));
  const bytes = Buffer.from(v);
  for (let start = 0; start + 16 <= bytes.length; start++)
    out.push(bytes.subarray(start, start + 16));
  return out;
}

test('random inputs never keep a value, and every chunking agrees', () => {
  for (let round = 0; round < 150; round++) {
    const secrets = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) => ({
      name: `S${i}`,
      value: value(),
      placeholder: `fnox_proxy_${String(round * 10 + i).padStart(24, '0')}`,
    }));
    const scrubber = compile(secrets);
    let input = '';
    for (let piece = 0; piece < 6; piece++) {
      input += word(0, 20);
      if (random() < 0.6) input += pick(encodings)(pick(secrets).value);
    }
    const bytes = new TextEncoder().encode(input);
    const whole = scrubber.bytes(bytes);
    const output = Buffer.from(whole.bytes);
    const flat = Buffer.from(output.filter((byte) => byte !== 10 && byte !== 13));
    for (const secret of secrets) {
      assert.ok(
        !output.includes(Buffer.from(secret.value)),
        `round ${round}: the raw value survived`
      );
      for (const form of forms(secret.value)) {
        const needle = Buffer.from(form.filter((byte) => byte !== 10 && byte !== 13));
        assert.ok(
          !output.includes(form),
          `round ${round}: ${form} survived in ${JSON.stringify(input)}`
        );
        if (/^[0-9A-Za-z+/=_-]+$/.test(form.toString())) {
          assert.ok(!flat.includes(needle), `round ${round}: wrapped ${form} survived`);
        }
      }
    }
    const stream = scrubber.stream();
    const parts = [];
    for (let at = 0; at < bytes.length; ) {
      const size = 1 + Math.floor(random() * 9);
      parts.push(stream.push(bytes.subarray(at, at + size)));
      at += size;
    }
    parts.push(stream.end());
    assert.deepEqual(
      Buffer.concat(parts.map((part) => Buffer.from(part))),
      Buffer.from(whole.bytes),
      `round ${round}`
    );
  }
});

test('with sameLength, random inputs keep their length, their line breaks and every byte outside a match, keep no value, and every chunking agrees', () => {
  for (let round = 0; round < 150; round++) {
    const secrets = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) => ({
      name: `S${i}`,
      value: value(),
      placeholder: `fnox_proxy_${String(round * 10 + i).padStart(24, '0')}`,
    }));
    const plain = compile(secrets);
    const scrubber = compile(secrets, { sameLength: true });
    let input = '';
    for (let piece = 0; piece < 6; piece++) {
      input += word(0, 20);
      if (random() < 0.6) input += pick(encodings)(pick(secrets).value);
    }
    const bytes = new TextEncoder().encode(input);
    const whole = scrubber.bytes(bytes);
    const output = Buffer.from(whole.bytes);
    assert.equal(output.length, bytes.length, `round ${round}: the length changed`);
    assert.deepEqual(whole.hits, plain.bytes(bytes).hits, `round ${round}: other hits`);
    for (let i = 0; i < bytes.length; i++) {
      if (output[i] !== bytes[i]) assert.equal(output[i], 0x2a, `round ${round}: byte ${i}`);
      if (bytes[i] === 10 || bytes[i] === 13) assert.equal(output[i], bytes[i]);
    }
    const flat = Buffer.from(output.filter((byte) => byte !== 10 && byte !== 13));
    for (const secret of secrets) {
      assert.ok(!output.includes(Buffer.from(secret.value)), `round ${round}: the value survived`);
      for (const form of forms(secret.value)) {
        assert.ok(!output.includes(form), `round ${round}: ${form} survived`);
        if (/^[0-9A-Za-z+/=_-]+$/.test(form.toString())) {
          assert.ok(!flat.includes(form), `round ${round}: wrapped ${form} survived`);
        }
      }
    }
    const stream = scrubber.stream();
    const parts = [];
    for (let at = 0; at < bytes.length; ) {
      const size = 1 + Math.floor(random() * 9);
      parts.push(stream.push(bytes.subarray(at, at + size)));
      at += size;
    }
    parts.push(stream.end());
    assert.deepEqual(
      Buffer.concat(parts.map((part) => Buffer.from(part))),
      output,
      `round ${round}`
    );
  }
});
