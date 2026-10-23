import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, FRAGMENT, MIN_VALUE } from '../../dist/index.js';

const TOKEN = {
  name: 'TOKEN',
  value: 'tok_0123456789abcdefghij',
  placeholder: 'fnox_proxy_000000000000000000000001',
};
const decode = (bytes) => new TextDecoder().decode(bytes);
const encode = (text) => new TextEncoder().encode(text);

test('the thresholds', () => {
  assert.equal(FRAGMENT, 16);
  assert.equal(MIN_VALUE, 8);
});

test('values shorter than 8 bytes are refused', () => {
  assert.throws(() => compile([{ name: 'X', value: 'seven77', placeholder: 'p' }]), RangeError);
  assert.doesNotThrow(() => compile([{ name: 'X', value: 'eight888', placeholder: 'p' }]));
});

test('an empty scrubber passes everything through', () => {
  const scrubber = compile([]);
  assert.deepEqual(scrubber.text('anything'), { text: 'anything', hits: [] });
  const stream = scrubber.stream();
  assert.equal(decode(stream.push(encode('abc'))), 'abc');
  assert.equal(stream.end().length, 0);
  assert.equal(scrubber.size, 0);
});

test('options and the version', () => {
  const scrubber = compile([TOKEN], { idleMs: 50, version: 7 });
  assert.equal(scrubber.idleMs, 50);
  assert.equal(scrubber.version, 7);
  assert.equal(compile([TOKEN]).idleMs, 250);
  assert.equal(compile([TOKEN]).version, 0);
});

test('streaming holds back only a possible prefix', () => {
  const stream = compile([TOKEN]).stream();
  assert.equal(decode(stream.push(encode('$ echo hi\nhi\n$ '))), '$ echo hi\nhi\n$ ');
  assert.equal(decode(stream.push(encode('tok_0123'))), '');
  assert.equal(decode(stream.idle()), 'tok_0123');
  assert.equal(decode(stream.push(encode('tok_0123456789abcdef'))), '');
  assert.equal(stream.idle().length, 0);
  assert.equal(decode(stream.push(encode('ghij done'))), `${TOKEN.placeholder} done`);
  assert.equal(stream.end().length, 0);
  assert.deepEqual(stream.hits, [{ name: 'TOKEN', form: 'raw', count: 1 }]);
});

test('a truncated stream still redacts the fragment at the end', () => {
  const stream = compile([TOKEN]).stream();
  const head = decode(stream.push(encode('cut: tok_0123456789abcdef')));
  assert.equal(head, 'cut: ');
  assert.equal(decode(stream.end()), '[redacted:TOKEN]');
});

test('idle on nothing returns nothing', () => {
  const stream = compile([TOKEN]).stream();
  assert.equal(stream.idle().length, 0);
});

test('the compiled scrubber keeps its own copy of the secrets', () => {
  const list = [{ ...TOKEN }];
  const scrubber = compile(list);
  list.length = 0;
  assert.equal(scrubber.text(TOKEN.value).text, TOKEN.placeholder);
  const stream = scrubber.stream();
  assert.equal(decode(stream.push(encode(`${TOKEN.value} `))), `${TOKEN.placeholder} `);
});

test('sameLength replaces every form with as many filler bytes as it matched, keeps CR and LF, and is off by default', () => {
  const value = TOKEN.value;
  const b64 = Buffer.from(value).toString('base64');
  const hex = Buffer.from(value).toString('hex');
  const pct = encodeURIComponent('other secret é 42');
  const wrapped = b64.replace(/(.{10})/g, '$1\r\n');
  const secrets = [
    TOKEN,
    {
      name: 'SPACE',
      value: 'other secret é 42',
      placeholder: 'fnox_proxy_000000000000000000000002',
    },
  ];
  const input = `a ${value} b ${b64} c ${hex} d ${pct} e ${wrapped} f`;
  const same = compile(secrets, { sameLength: true });
  const out = same.text(input).text;
  const stars = (n) => '*'.repeat(n);
  assert.equal(
    out,
    `a ${stars(value.length)} b ${stars(b64.length)} c ${stars(hex.length)} d ${stars(pct.length)} e ${wrapped.replace(/[^\r\n]/g, '*')} f`
  );
  assert.equal(encode(out).length, encode(input).length);
  assert.deepEqual(same.hits ?? [], []);
  assert.equal(compile(secrets).text(`a ${value}`).text, `a ${TOKEN.placeholder}`);
  assert.equal(
    compile(secrets, { sameLength: false }).text(`a ${value}`).text,
    `a ${TOKEN.placeholder}`
  );
});
