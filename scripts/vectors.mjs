import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';

const P = (n) => `fnox_proxy_${n.toString(16).padStart(24, '0')}`;
const S = {
  GH: { name: 'GH_TOKEN', value: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', placeholder: P(1) },
  NPM: { name: 'NPM_TOKEN', value: 'npm_Zz9Yy8Xx7Ww6', placeholder: P(2) },
  PASS: { name: 'DB_PASS', value: 'p@ss w/rd+&<"\'>', placeholder: P(3) },
  UNI: { name: 'UNI_KEY', value: 'clé-secrète-ünïcode-✓', placeholder: P(4) },
  SHORT: { name: 'PIN', value: 'k9#Lm2$Q', placeholder: P(5) },
  BIN: { name: 'B64_KEY', value: '~~~>>>???___~~~>>>???', placeholder: P(6) },
  INNER: { name: 'INNER', value: 'abcdefgh12345678', placeholder: P(7) },
  OUTER: { name: 'OUTER', value: 'abcdefgh12345678XYZ', placeholder: P(8) },
};
const red = (secret) => `[redacted:${secret.name}]`;
const b64 = (text) => Buffer.from(text).toString('base64');
const b64u = (text) => Buffer.from(text).toString('base64url');
const hex = (text) => Buffer.from(text).toString('hex');

function within(prefix, secret, suffix, url = false) {
  const encoded = url ? b64u(prefix + secret.value + suffix) : b64(prefix + secret.value + suffix);
  const k = Buffer.byteLength(prefix);
  const n = Buffer.byteLength(secret.value);
  const first = Math.ceil((8 * k) / 6);
  const last = Math.floor((8 * (k + n)) / 6);
  return { input: encoded, output: encoded.slice(0, first) + red(secret) + encoded.slice(last) };
}

const cases = [];
function add(name, secrets, segments, hits) {
  let input = '';
  let output = '';
  for (const segment of segments) {
    if (typeof segment === 'string') {
      input += segment;
      output += segment;
    } else {
      input += segment[0];
      output += segment[1];
    }
  }
  cases.push({ name, secrets, input, output, hits });
}
const raw = (secret) => [secret.value, secret.placeholder];
const as = (text, secret) => [text, red(secret)];

add('nothing to scrub', [S.GH], ['hello world, no secrets here\n'], []);
add(
  'raw in a header',
  [S.GH],
  ['Authorization: Bearer ', raw(S.GH), '\r\n'],
  [['GH_TOKEN', 'raw', 1]]
);
add('raw is the whole input', [S.GH], [raw(S.GH)], [['GH_TOKEN', 'raw', 1]]);
add('raw three times', [S.GH], [raw(S.GH), ' ', raw(S.GH), raw(S.GH)], [['GH_TOKEN', 'raw', 3]]);
add(
  'two values side by side',
  [S.GH, S.NPM],
  [raw(S.NPM), raw(S.GH), '!'],
  [
    ['NPM_TOKEN', 'raw', 1],
    ['GH_TOKEN', 'raw', 1],
  ]
);
add(
  'a short value is raw only',
  [S.SHORT],
  ['pin=', raw(S.SHORT), ' and part k9#Lm2$ stays'],
  [['PIN', 'raw', 1]]
);
add(
  'a fragment of 20 bytes',
  [S.GH],
  ['head -c: ', as(S.GH.value.slice(0, 20), S.GH), '\n'],
  [['GH_TOKEN', 'fragment', 1]]
);
add(
  'a fragment from the middle',
  [S.GH],
  ['cut: ', as(S.GH.value.slice(7, 30), S.GH), '.'],
  [['GH_TOKEN', 'fragment', 1]]
);
add(
  'a fragment of exactly 16 bytes',
  [S.GH],
  ['x', as(S.GH.value.slice(24), S.GH), 'y'],
  [['GH_TOKEN', 'fragment', 1]]
);
add('15 bytes are not a fragment', [S.GH], [`x${S.GH.value.slice(0, 15)}y`], []);
add(
  'a value split over two results',
  [S.GH],
  [as(S.GH.value.slice(0, 20), S.GH), '\n---\n', as(S.GH.value.slice(20), S.GH)],
  [['GH_TOKEN', 'fragment', 2]]
);
add(
  'JSON-escaped',
  [S.PASS],
  ['{"password":"', as(JSON.stringify(S.PASS.value).slice(1, -1), S.PASS), '"}'],
  [['DB_PASS', 'json', 1]]
);
add(
  'JSON with escaped slashes',
  [S.PASS],
  ['{"p":"', as(JSON.stringify(S.PASS.value).slice(1, -1).replace(/\//g, '\\/'), S.PASS), '"}'],
  [['DB_PASS', 'json', 1]]
);
const lowerU = [...S.UNI.value]
  .map((c) => (c.charCodeAt(0) > 0x7e ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c))
  .join('');
add(
  'JSON with \\u escapes, lower and upper',
  [S.UNI],
  [
    '"',
    as(lowerU, S.UNI),
    '" "',
    as(
      lowerU.replace(/\\u([0-9a-f]{4})/g, (_, h) => `\\u${h.toUpperCase()}`),
      S.UNI
    ),
    '"',
  ],
  [['UNI_KEY', 'json', 2]]
);
add('raw non-ASCII', [S.UNI], ['k=', raw(S.UNI)], [['UNI_KEY', 'raw', 1]]);
add(
  'percent-encoded',
  [S.PASS],
  ['?p=', as(encodeURIComponent(S.PASS.value), S.PASS), '&x=1'],
  [['DB_PASS', 'percent', 1]]
);
add(
  'percent-encoded with lower hex',
  [S.PASS],
  [
    '?p=',
    as(
      encodeURIComponent(S.PASS.value).replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase()),
      S.PASS
    ),
  ],
  [['DB_PASS', 'percent', 1]]
);
add(
  'form-encoded',
  [S.PASS],
  ['p=', as(new URLSearchParams({ p: S.PASS.value }).toString().slice(2), S.PASS), '&q=2'],
  [['DB_PASS', 'percent', 1]]
);
add(
  'HTML entities',
  [S.PASS],
  [
    '<td>',
    as('p@ss w/rd+&amp;&lt;&quot;&#39;&gt;', S.PASS),
    '</td><td>',
    as('p@ss w/rd+&amp;&lt;&quot;&#x27;&gt;', S.PASS),
    '</td>',
  ],
  [['DB_PASS', 'html', 2]]
);
add(
  'base64, padded and unpadded',
  [S.GH],
  [as(b64(S.GH.value), S.GH), ' ', as(b64(S.GH.value).replace(/=+$/, ''), S.GH), ' '],
  [['GH_TOKEN', 'base64', 2]]
);
add('base64url', [S.BIN], ['t=', as(b64u(S.BIN.value), S.BIN), '.'], [['B64_KEY', 'base64', 1]]);
for (const prefix of ['', 'a', 'ab']) {
  const inside = within(prefix, S.GH, 'tail-bytes');
  add(
    `base64 at byte offset ${prefix.length}`,
    [S.GH],
    [[inside.input, inside.output]],
    [['GH_TOKEN', 'base64', 1]]
  );
}
add(
  'Basic with the value as password',
  [S.GH],
  [
    'Authorization: Basic ',
    [b64(`x-access-token:${S.GH.value}`), `${b64('x-access-token:').slice(0, 20)}${red(S.GH)}`],
  ],
  [['GH_TOKEN', 'base64', 1]]
);
const user = within('', S.GH, ':x-oauth-basic');
add(
  'Basic with the value as user',
  [S.GH],
  ['Authorization: Basic ', [user.input, user.output]],
  [['GH_TOKEN', 'base64', 1]]
);
const jwt = within('{"alg":"none","key":"', S.GH, '"}', true);
add(
  'a JWT-like segment',
  [S.GH],
  ['eyJ0eXAiOiJKV1QifQ.', [jwt.input, jwt.output], '.sig'],
  [['GH_TOKEN', 'base64', 1]]
);
add(
  'hex lower and upper',
  [S.NPM],
  ['sha: ', as(hex(S.NPM.value), S.NPM), ' ', as(hex(S.NPM.value).toUpperCase(), S.NPM)],
  [['NPM_TOKEN', 'hex', 2]]
);
add(
  'base64 wrapped at 20 columns',
  [S.GH],
  [
    '-----BEGIN-----\n',
    as(b64(S.GH.value).replace(/(.{20})(?!$)/g, '$1\n'), S.GH),
    '\n-----END-----',
  ],
  [['GH_TOKEN', 'wrapped', 1]]
);
add(
  'base64 wrapped with CRLF',
  [S.GH],
  [as(b64(S.GH.value).replace(/(.{16})(?!$)/g, '$1\r\n'), S.GH)],
  [['GH_TOKEN', 'wrapped', 1]]
);
add(
  'hex wrapped at 30 columns',
  [S.NPM],
  [as(hex(S.NPM.value).replace(/(.{30})(?!$)/g, '$1\n'), S.NPM), '\n'],
  [['NPM_TOKEN', 'wrapped', 1]]
);
add(
  'the longer value wins where two overlap',
  [S.INNER, S.OUTER],
  ['[', raw(S.OUTER), '] [', raw(S.INNER), ']'],
  [
    ['OUTER', 'raw', 1],
    ['INNER', 'raw', 1],
  ]
);
add(
  'leftmost wins over longest',
  [S.GH, S.NPM],
  ['z', raw(S.NPM), raw(S.GH)],
  [
    ['NPM_TOKEN', 'raw', 1],
    ['GH_TOKEN', 'raw', 1],
  ]
);
add(
  'replaced text is not rescanned',
  [S.GH],
  [raw(S.GH), S.GH.placeholder],
  [['GH_TOKEN', 'raw', 1]]
);
add('a placeholder alone is left as is', [S.GH], [`env GH_TOKEN=${S.GH.placeholder}`], []);

const out = cases.map(({ name, secrets, input, output, hits }) => ({
  name,
  secrets,
  input,
  output,
  hits: hits.map(([n, form, count]) => ({ name: n, form, count })),
}));
const bytes = { name: 'a fragment that cuts a multi-byte character', secrets: [S.UNI] };
const uni = Buffer.from(S.UNI.value);
const slice = uni.subarray(3, 22);
bytes.inputHex = Buffer.concat([Buffer.from('>'), slice, Buffer.from('<')]).toString('hex');
bytes.outputHex = Buffer.concat([
  Buffer.from('>'),
  Buffer.from(red(S.UNI)),
  Buffer.from('<'),
]).toString('hex');
bytes.hits = [{ name: 'UNI_KEY', form: 'fragment', count: 1 }];
out.push(bytes);
const vectors = { format: 1, fragment: 16, minValue: 8, idleMs: 250, cases: out };
writeFileSync(new URL('../vectors.json', import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
