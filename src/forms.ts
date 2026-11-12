export type Form = 'raw' | 'fragment' | 'json' | 'percent' | 'html' | 'base64' | 'hex' | 'wrapped';

export const FRAGMENT = 16;
export const MIN_VALUE = 8;
export const MIN_BASE64 = 8;

export interface Source {
  secret: number;
  form: Form;
  offset?: number;
  piece?: number;
}

export interface Shape {
  bytes: Uint8Array;
  form: Form;
  offset?: number;
  piece?: number;
}

export interface Fragments {
  pieces: Uint8Array[];
  whole: boolean;
}

const encoder = new TextEncoder();
const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function base64(bytes: Uint8Array, padded = true): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    const left = bytes.length - i;
    out += STD[(triple >> 18) & 63] + STD[(triple >> 12) & 63];
    out += left > 1 ? STD[(triple >> 6) & 63] : padded ? '=' : '';
    out += left > 2 ? STD[triple & 63] : padded ? '=' : '';
  }
  return out;
}

export function urlSafe(text: string): string {
  return text.replace(/\+/g, '-').replace(/\//g, '_');
}

export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function embedded(bytes: Uint8Array, offset: number): string {
  const shifted = new Uint8Array(offset + bytes.length);
  shifted.set(bytes, offset);
  const encoded = base64(shifted);
  const first = Math.ceil((8 * offset) / 6);
  const last = Math.floor((8 * (offset + bytes.length)) / 6);
  return encoded.slice(first, last);
}

function unicode(value: string, upper: boolean): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit === 0x22) out += '\\"';
    else if (unit === 0x5c) out += '\\\\';
    else if (unit < 0x20 || unit > 0x7e) {
      const code = unit.toString(16).padStart(4, '0');
      out += `\\u${upper ? code.toUpperCase() : code}`;
    } else out += value[i];
  }
  return out;
}

function percent(value: string): string[] {
  let component: string;
  try {
    component = encodeURIComponent(value);
  } catch {
    return [];
  }
  const lower = component.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
  const plus = component.replace(/%20/g, '+');
  let form = '';
  for (const byte of utf8(value)) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9*\-._]/.test(char)) form += char;
    else if (byte === 0x20) form += '+';
    else form += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return [component, lower, plus, form];
}

function html(value: string, apostrophe: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, apostrophe);
}

function encodings(bytes: Uint8Array): string[] {
  const standard = [base64(bytes), base64(bytes, false)];
  for (const offset of [0, 1, 2]) {
    const run = embedded(bytes, offset);
    if (run.length >= MIN_BASE64) standard.push(run);
  }
  return [...standard, ...standard.map(urlSafe)];
}

function windows(length: number): number[] {
  const out: number[] = [];
  for (let offset = 0; offset + FRAGMENT <= length; offset++) out.push(offset);
  return out;
}

function strings(document: object): string[] {
  const out: string[] = [];
  const stack: unknown[] = [document];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') out.push(item);
    if (typeof item !== 'object' || item === null) continue;
    for (const child of Object.values(item)) stack.push(child);
  }
  return out;
}

const DOMAIN = '(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}';
const HOST = new RegExp(`^${DOMAIN}$`);
const EMAIL = new RegExp(`^[^\\s@]+@${DOMAIN}$`);
const URL_SHAPE = new RegExp(`^https?://${DOMAIN}(?::[0-9]{1,5})?((?:/[^/?#\\s]*)*)$`);
const ARMOR = /^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/;

function unescaped(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function address(leaf: string): boolean {
  if (HOST.test(leaf) || EMAIL.test(leaf)) return true;
  const url = URL_SHAPE.exec(leaf);
  if (!url) return false;
  return url[1]
    .split('/')
    .every((segment) => utf8(segment).length < FRAGMENT || EMAIL.test(unescaped(segment)));
}

function lines(leaf: string): string[] {
  if (address(leaf)) return [];
  return leaf
    .split(/[\r\n"\\]/)
    .filter((line) => utf8(line).length >= FRAGMENT && !ARMOR.test(line));
}

function parsed(value: string): object | null {
  try {
    const document: unknown = JSON.parse(value);
    return typeof document === 'object' && document !== null ? document : null;
  } catch {
    return null;
  }
}

export function fragments(value: string): Fragments {
  const raw = utf8(value);
  const document = parsed(value);
  if (!document) return { pieces: [raw], whole: true };
  return { pieces: [...new Set(strings(document).flatMap(lines))].map(utf8), whole: false };
}

export function shapes(value: string, split: Fragments = fragments(value)): Shape[] {
  const raw = utf8(value);
  const seen = new Set<string>([value]);
  const out: Shape[] = [];
  if (raw.length < FRAGMENT || !split.whole) out.push({ bytes: raw, form: 'raw' });
  split.pieces.forEach((bytes, piece) => {
    for (const offset of windows(bytes.length)) {
      out.push({
        bytes: bytes.subarray(offset, offset + FRAGMENT),
        form: 'fragment',
        offset,
        piece,
      });
    }
  });
  const add = (text: string, form: Form) => {
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ bytes: utf8(text), form });
  };
  const json = JSON.stringify(value).slice(1, -1);
  for (const text of [
    json,
    json.replace(/\//g, '\\/'),
    unicode(value, false),
    unicode(value, true),
  ]) {
    add(text, 'json');
  }
  for (const text of percent(value)) add(text, 'percent');
  for (const text of [html(value, '&#39;'), html(value, '&#x27;')]) add(text, 'html');
  for (const text of encodings(raw)) add(text, 'base64');
  add(hex(raw), 'hex');
  add(hex(raw).toUpperCase(), 'hex');
  return out;
}

export function wrappable(form: Form): boolean {
  return form === 'base64' || form === 'hex';
}
