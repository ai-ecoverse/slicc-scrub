import { Automaton } from './automaton.ts';
import { type Form, FRAGMENT, MIN_VALUE, type Source, shapes, utf8, wrappable } from './forms.ts';

export interface Secret {
  name: string;
  value: string;
  placeholder: string;
}

export interface Hit {
  name: string;
  form: Form;
  count: number;
}

export interface Options {
  idleMs?: number;
  version?: number;
}

export interface Stream {
  push(chunk: Uint8Array): Uint8Array;
  idle(): Uint8Array;
  end(): Uint8Array;
  readonly hits: Hit[];
}

export interface Scrubber {
  readonly version: number;
  readonly idleMs: number;
  readonly size: number;
  text(input: string): { text: string; hits: Hit[] };
  bytes(input: Uint8Array): { bytes: Uint8Array; hits: Hit[] };
  stream(): Stream;
}

interface Candidate {
  start: number;
  end: number;
  secret: number;
  form: Form;
  rank: number;
  growing: boolean;
}

interface Compiled {
  secrets: Secret[];
  values: Uint8Array[];
  main: Automaton;
  wrap: Automaton;
  sources: Source[][];
  wrapSources: Source[][];
  replacements: Uint8Array[][];
}

const RANK: Record<Form, number> = {
  raw: 0,
  fragment: 1,
  json: 2,
  percent: 3,
  html: 4,
  base64: 5,
  hex: 6,
  wrapped: 7,
};
const CR = 13;
const LF = 10;
const EMPTY = new Uint8Array(0);

function register(
  automaton: Automaton,
  sources: Source[][],
  ids: Map<string, number>,
  bytes: Uint8Array,
  source: Source
): void {
  const key = Array.from(bytes).join(',');
  let id = ids.get(key);
  if (id === undefined) {
    id = automaton.add(bytes);
    ids.set(key, id);
    sources[id] = [];
  }
  sources[id].push(source);
}

function prepare(secrets: Secret[]): Compiled {
  const main = new Automaton();
  const wrap = new Automaton();
  const sources: Source[][] = [];
  const wrapSources: Source[][] = [];
  const ids = new Map<string, number>();
  const wrapIds = new Map<string, number>();
  const values = secrets.map((secret) => utf8(secret.value));
  secrets.forEach((secret, index) => {
    if (typeof secret.value !== 'string' || values[index].length < MIN_VALUE) {
      throw new RangeError(`the value of ${secret.name} is shorter than ${MIN_VALUE} bytes`);
    }
    for (const shape of shapes(secret.value)) {
      const source: Source = { secret: index, form: shape.form, offset: shape.offset };
      register(main, sources, ids, shape.bytes, source);
      if (wrappable(shape.form)) register(wrap, wrapSources, wrapIds, shape.bytes, source);
    }
  });
  main.build();
  wrap.build();
  const replacements = secrets.map((secret) => [
    utf8(secret.placeholder),
    utf8(`[redacted:${secret.name}]`),
  ]);
  return { secrets, values, main, wrap, sources, wrapSources, replacements };
}

function better(a: Candidate, b: Candidate | undefined): boolean {
  if (!b) return true;
  if (a.end !== b.end) return a.end > b.end;
  if (a.rank !== b.rank) return a.rank < b.rank;
  return a.secret < b.secret;
}

function resolve(
  c: Compiled,
  input: Uint8Array,
  start: number,
  end: number,
  source: Source
): Candidate {
  if (source.form !== 'fragment') {
    return {
      start,
      end,
      secret: source.secret,
      form: source.form,
      rank: RANK[source.form],
      growing: false,
    };
  }
  const value = c.values[source.secret];
  let stop = end;
  let at = (source.offset as number) + FRAGMENT;
  while (stop < input.length && at < value.length && input[stop] === value[at]) {
    stop++;
    at++;
  }
  const form: Form = source.offset === 0 && at === value.length ? 'raw' : 'fragment';
  const growing = stop === input.length && at < value.length;
  return { start, end: stop, secret: source.secret, form, rank: RANK[form], growing };
}

function keep(best: Map<number, Candidate>, candidate: Candidate): void {
  if (better(candidate, best.get(candidate.start))) best.set(candidate.start, candidate);
}

function scanMain(
  c: Compiled,
  input: Uint8Array,
  best: Map<number, Candidate>,
  partials: number[]
): void {
  let state = 0;
  for (let i = 0; i < input.length; i++) {
    state = c.main.step(state, input[i]);
    c.main.matches(state, (id) => {
      const start = i + 1 - c.main.lengths[id];
      for (const source of c.sources[id]) {
        const candidate = resolve(c, input, start, i + 1, source);
        if (candidate.growing) partials.push(candidate.start);
        keep(best, candidate);
      }
    });
  }
  c.main.partials(state, input.length, (start) => partials.push(start));
}

function scanWrapped(
  c: Compiled,
  input: Uint8Array,
  best: Map<number, Candidate>,
  partials: number[]
): void {
  const map: number[] = [];
  for (let i = 0; i < input.length; i++) if (input[i] !== CR && input[i] !== LF) map.push(i);
  if (map.length === input.length) return;
  let state = 0;
  for (let v = 0; v < map.length; v++) {
    state = c.wrap.step(state, input[map[v]]);
    c.wrap.matches(state, (id) => {
      const first = v + 1 - c.wrap.lengths[id];
      const start = map[first];
      const end = map[v] + 1;
      const wrapped = end - start !== c.wrap.lengths[id];
      for (const source of c.wrapSources[id]) {
        const form: Form = wrapped ? 'wrapped' : source.form;
        keep(best, { start, end, secret: source.secret, form, rank: RANK[form], growing: false });
      }
    });
  }
  c.wrap.partials(state, map.length, (start) => partials.push(map[start]));
}

interface Pass {
  output: Uint8Array;
  cut: number;
  hits: Map<string, Hit>;
}

function count(c: Compiled, hits: Map<string, Hit>, candidate: Candidate): void {
  const name = c.secrets[candidate.secret].name;
  const key = `${name}\u0000${candidate.form}`;
  const hit = hits.get(key) ?? { name, form: candidate.form, count: 0 };
  hit.count += 1;
  hits.set(key, hit);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function pass(c: Compiled, input: Uint8Array, final: boolean): Pass {
  const best = new Map<number, Candidate>();
  const partials: number[] = [];
  scanMain(c, input, best, partials);
  scanWrapped(c, input, best, partials);
  const holds = final ? [] : [...new Set(partials)].sort((a, b) => a - b);
  const starts = [...best.keys()].sort((a, b) => a - b);
  const parts: Uint8Array[] = [];
  const hits = new Map<string, Hit>();
  let pos = 0;
  let cut = input.length;
  let s = 0;
  let h = 0;
  for (;;) {
    while (s < starts.length && starts[s] < pos) s++;
    while (h < holds.length && holds[h] < pos) h++;
    const hold = h < holds.length ? holds[h] : Infinity;
    const next = s < starts.length ? starts[s] : Infinity;
    if (hold <= next) {
      cut = Math.min(hold, input.length);
      break;
    }
    const candidate = best.get(next) as Candidate;
    parts.push(
      input.subarray(pos, next),
      c.replacements[candidate.secret][candidate.form === 'raw' ? 0 : 1]
    );
    count(c, hits, candidate);
    pos = candidate.end;
  }
  parts.push(input.subarray(pos, cut));
  return { output: concat(parts), cut, hits };
}

function merge(into: Map<string, Hit>, from: Map<string, Hit>): void {
  for (const [key, hit] of from) {
    const known = into.get(key);
    if (known) known.count += hit.count;
    else into.set(key, { ...hit });
  }
}

export function compile(secrets: Secret[], options: Options = {}): Scrubber {
  const c = prepare(secrets.map((secret) => ({ ...secret })));
  const decoder = new TextDecoder();
  const idleMs = options.idleMs ?? 250;
  const scrubBytes = (input: Uint8Array) => {
    if (c.secrets.length === 0) return { bytes: input.slice(), hits: [] };
    const result = pass(c, input, true);
    return { bytes: result.output, hits: [...result.hits.values()] };
  };
  return {
    version: options.version ?? 0,
    idleMs,
    size: c.main.lengths.length,
    bytes: scrubBytes,
    text(input) {
      const { bytes, hits } = scrubBytes(utf8(input));
      return { text: decoder.decode(bytes), hits };
    },
    stream() {
      let pending: Uint8Array = EMPTY;
      const hits = new Map<string, Hit>();
      const run = (final: boolean) => {
        if (c.secrets.length === 0 || pending.length === 0) {
          const out = pending;
          pending = EMPTY;
          return out;
        }
        const result = pass(c, pending, final);
        merge(hits, result.hits);
        pending = pending.slice(result.cut);
        return result.output;
      };
      return {
        push(chunk) {
          pending = concat([pending, chunk]);
          return run(false);
        },
        idle() {
          return pending.length < FRAGMENT ? run(true) : EMPTY;
        },
        end() {
          return run(true);
        },
        get hits() {
          return [...hits.values()];
        },
      };
    },
  };
}
