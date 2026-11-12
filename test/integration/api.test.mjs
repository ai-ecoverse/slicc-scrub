import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
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

function serviceAccount() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const email = 'x@helix-225321.iam.gserviceaccount.com';
  return {
    type: 'service_account',
    project_id: 'helix-225321',
    private_key_id: randomBytes(20).toString('hex'),
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: email,
    client_id: '118000000000000000001',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(email)}`,
    universe_domain: 'googleapis.com',
  };
}

test('a service-account key sealed whole leaves a JSON body of its public strings as it is', () => {
  const sa = serviceAccount();
  const scrubber = compile([
    { name: 'GCLOUD_CREDENTIALS', value: JSON.stringify(sa), placeholder: TOKEN.placeholder },
  ]);
  const script = `const k = "-----BEGIN PRIVATE KEY-----\\n" + b; fetch("${sa.auth_uri}"); // ${sa.client_email}`;
  const body = JSON.stringify({
    messages: [
      {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 't1', name: 'bash', input: { command: script } } }],
      },
      { role: 'user', content: [{ text: `see ${sa.auth_uri} and ${sa.client_email}` }] },
    ],
  });
  const out = scrubber.text(body);
  assert.deepEqual(out.hits, []);
  assert.equal(out.text, body);
  assert.doesNotThrow(() => JSON.parse(out.text));
});

test('a service-account key sealed whole is still caught, whole, cut and as its PEM, in a parseable JSON body', () => {
  const sa = serviceAccount();
  const value = JSON.stringify(sa);
  const scrubber = compile([{ name: 'GCLOUD_CREDENTIALS', value, placeholder: TOKEN.placeholder }]);
  const pem = sa.private_key;
  const body = JSON.stringify({
    messages: [
      { text: `cat key.json\n${JSON.stringify(sa, null, 2)}` },
      { text: `jq -c: ${value}` },
      { text: `head -c 300: ${value.slice(0, 300)}` },
      { text: `the pem:\n${pem}` },
      { text: `echo "${pem.slice(100, 400)}"` },
    ],
  });
  const out = scrubber.text(body);
  const parsed = JSON.parse(out.text);
  const decoded = parsed.messages.map((m) => m.text).join('\n');
  assert.ok(!out.text.includes(value) && !decoded.includes(value));
  assert.ok(!decoded.includes(sa.private_key_id.slice(0, 16)));
  for (const line of pem.split('\n').filter((l) => l && !l.startsWith('-----'))) {
    for (let at = 0; at + 16 <= line.length; at++) {
      assert.ok(!decoded.includes(line.slice(at, at + 16)), `${line.slice(at, at + 16)} survived`);
    }
  }
  assert.ok(decoded.includes(sa.auth_uri));
  assert.ok(decoded.includes('-----BEGIN PRIVATE KEY-----'));
});
