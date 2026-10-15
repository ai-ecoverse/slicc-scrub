# slicc-scrub

One scrubber for every place a SLICC secret could slip into a model's context: the vault's `forward` responses and model requests, the kernel's exec children, and slicc-agent's tool output. It replaces a secret's value, in every encoding below, before the text moves on. The design is §3.15 of `secrets-tokens-design.md` (revision 4) in slicc-agent-plan; this README is the spec of what's built.

- **Zero runtime dependencies,** no DOM and no Node APIs, no `eval` and no generated code. It runs as-is in a browser frame, a worker, Node and the kernel.
- **Deterministic:** the same values and input always give the same output.
- **One set of vectors,** `vectors.json`, which every consumer runs against its copy.

```js
import { compile } from '@ai-ecoverse/slicc-scrub';

const scrubber = compile([{ name: 'GH_TOKEN', value: 'ghp_…', placeholder: 'fnox_proxy_…' }], { version: 3 });
scrubber.text('token: ghp_…');
```

## API

| | |
|---|---|
| `compile(secrets, options?) → Scrubber` | `secrets` is `{ name, value, placeholder }[]`. A value shorter than 8 bytes of UTF-8 throws a `RangeError`: it can't be told apart from ordinary output. `options` are `idleMs` (default 250) and `version` (default 0), both only echoed back |
| `scrubber.text(string) → { text, hits }` | scrubs UTF-8 text. A fragment match can cut a multi-byte character; its remains decode as U+FFFD |
| `scrubber.bytes(Uint8Array) → { bytes, hits }` | scrubs bytes |
| `scrubber.stream() → Stream` | scrubs a stream, below |
| `scrubber.version`, `scrubber.idleMs`, `scrubber.size` | the options, and the number of distinct patterns |
| `FRAGMENT`, `MIN_VALUE` | 16 and 8 |

`hits` is `[{ name, form, count }]`: how often each secret was found in each form (`raw`, `fragment`, `json`, `percent`, `html`, `base64`, `hex`, `wrapped`). It never contains a value.

## The forms

Each value *v* is matched, as UTF-8 bytes, in these forms. A form is added only when it differs from the ones before it.

| form | what is matched |
|---|---|
| `raw` | *v* itself |
| `fragment` | any run of 16 bytes or more of *v*. Values shorter than 16 bytes have none |
| `json` | the inside of `JSON.stringify(v)`; the same with `/` as `\/`; and with every control and non-ASCII UTF-16 unit as `\uXXXX`, in lower and in upper hex |
| `percent` | `encodeURIComponent(v)`; the same with lower-case hex; with `%20` as `+`; and form encoding (everything but `A–Z a–z 0–9 * - . _` escaped, space as `+`) |
| `html` | `&` `<` `>` `"` as `&amp;` `&lt;` `&gt;` `&quot;`, and `'` as `&#39;` or `&#x27;` |
| `base64` | the standard and URL-safe alphabets: the whole encoding, padded and unpadded, and, for *v* at each byte offset 0, 1 and 2 inside a longer encoded stream, the run of characters that depends only on *v*'s bytes (when it's at least 8 characters). That covers Basic `user:pass` with *v* on either side, JWT segments and base64'd JSON |
| `hex` | lower and upper, contiguous |
| `wrapped` | the `base64` and `hex` forms with CR and LF anywhere inside them (`base64 -w 76`, PEM, `xxd -p`) |

## Matching

- **One Aho–Corasick automaton** over every pattern, on bytes. Fragments are found from their 16-byte windows and extended byte by byte along the value. A second automaton over the `base64` and `hex` patterns runs on a view of the input with CR and LF removed, mapped back to the original bytes.
- **Leftmost, then longest:** at each point the match that starts first wins, and among those the longest. Ties go to `raw`, then `fragment`, `json`, `percent`, `html`, `base64`, `hex`, then the earlier secret. Matches never overlap, and replaced text is never scanned again.
- **Replacements:** a `raw` match (a fragment covering the whole value is one) becomes the secret's `placeholder`; anything else becomes `[redacted:<name>]`.
- Matching is case-sensitive; hex is matched in lower and upper case.

## Streaming

`stream()` returns `{ push(Uint8Array) → Uint8Array, idle() → Uint8Array, end() → Uint8Array, hits }`.

- **`push`** returns every byte that can no longer be part of a match, scrubbed, and holds back the rest: from the earliest point where the input so far could still become a match (a proper prefix of a pattern, a fragment still growing along its value, or a wrapped pattern across CR and LF). A match split across any chunking is therefore found exactly as in one piece; for every input, any chunking followed by `end()` gives the same bytes as `bytes()`.
- **`end`** scrubs and returns everything held.
- **`idle`** is for the caller to call after `idleMs` without input, so an interactive prompt can't stall. It releases the held bytes, scrubbed, **only when fewer than 16 are held**, and otherwise returns nothing. A held tail of 16 bytes or more could be the start of a longer match.
- `hits` totals the stream so far.

## Vectors

`vectors.json` (`@ai-ecoverse/slicc-scrub/vectors.json`) is `{ format: 1, fragment, minValue, idleMs, cases }`. Each case is `{ name, secrets, input, output, hits }`, or with `inputHex` and `outputHex` for bytes that aren't UTF-8. `scripts/vectors.mjs` writes it from how each input is built (Node's own base64, hex and URL encoders), never from the scrubber.

A consumer's test runs, for every case:
1. `bytes(input)` (and `text` where the case is text) gives `output` and `hits`, in any order;
2. for **every split point**, `push(first)`, `push(rest)`, `end()` gives `output`;
3. one byte at a time gives `output`.

## Develop

```sh
npm install
npm run build    # dist/index.js and dist/types
npm run lint
npm test         # the vectors at every split point, the API, and a fuzz test
npm run vectors  # rewrite vectors.json
```

Unit tests stay in the gitignored `test/unit/` (`npm run test:unit`), and the pre-commit hook requires them to cover every changed line of `src/`. The Biome, TypeScript, lefthook and Renovate configuration comes from [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web).

## Release

semantic-release on `main` tags a version from the conventional commits and publishes `@ai-ecoverse/slicc-scrub` to npm with provenance, through trusted publishing, when the repository variable `NPM_PUBLISH` is `true`. The release job runs only on `main` (`github.ref == 'refs/heads/main'`), also when dispatched by hand; `test/integration/workflows.test.mjs` keeps it so. CI's `runner` job (slicc-kernel's decider) runs `ci / test` on the bench pool (`vars.CERT_RUNNER`) for this repo's own pull requests and pushes to `main`, and on a hosted runner for a fork's code; `vars.CI_RUNNER` overrides it. The release stays on a hosted runner.
