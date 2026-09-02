/**
 * Pure-JavaScript MD4 (RFC 1320).
 *
 * Vendored on purpose: NTLM derives the NT hash as MD4(UTF-16LE(password)), and
 * OpenSSL 3 (bundled with modern Node.js) no longer exposes MD4 through the
 * `crypto` module. This implementation is only ever used for the NTLM handshake.
 */

function rotl(x: number, s: number): number {
  return ((x << s) | (x >>> (32 - s))) >>> 0;
}

function add(...xs: number[]): number {
  let acc = 0;
  for (const x of xs) acc = (acc + x) >>> 0;
  return acc >>> 0;
}

const F = (x: number, y: number, z: number): number => ((x & y) | (~x & z)) >>> 0;
const G = (x: number, y: number, z: number): number => ((x & y) | (x & z) | (y & z)) >>> 0;
const H = (x: number, y: number, z: number): number => (x ^ y ^ z) >>> 0;

export function md4(input: Buffer): Buffer {
  const len = input.length;
  const bitLenLo = (len * 8) >>> 0;
  const bitLenHi = Math.floor((len * 8) / 0x100000000) >>> 0;

  // Padded length: append 0x80, then zeros, then 8-byte little-endian bit length,
  // total a multiple of 64.
  const totalLen = (len + 1 + 8 + 63) & ~63;
  const msg = Buffer.alloc(totalLen);
  input.copy(msg);
  msg[len] = 0x80;
  msg.writeUInt32LE(bitLenLo, totalLen - 8);
  msg.writeUInt32LE(bitLenHi, totalLen - 4);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const X = new Array<number>(16);

  for (let off = 0; off < totalLen; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = msg.readUInt32LE(off + i * 4);

    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;

    const r1 = (p: number, q: number, r: number, s: number, k: number, shift: number): number =>
      rotl(add(p, F(q, r, s), X[k]!), shift);
    a = r1(a, b, c, d, 0, 3);
    d = r1(d, a, b, c, 1, 7);
    c = r1(c, d, a, b, 2, 11);
    b = r1(b, c, d, a, 3, 19);
    a = r1(a, b, c, d, 4, 3);
    d = r1(d, a, b, c, 5, 7);
    c = r1(c, d, a, b, 6, 11);
    b = r1(b, c, d, a, 7, 19);
    a = r1(a, b, c, d, 8, 3);
    d = r1(d, a, b, c, 9, 7);
    c = r1(c, d, a, b, 10, 11);
    b = r1(b, c, d, a, 11, 19);
    a = r1(a, b, c, d, 12, 3);
    d = r1(d, a, b, c, 13, 7);
    c = r1(c, d, a, b, 14, 11);
    b = r1(b, c, d, a, 15, 19);

    const r2 = (p: number, q: number, r: number, s: number, k: number, shift: number): number =>
      rotl(add(p, G(q, r, s), X[k]!, 0x5a827999), shift);
    a = r2(a, b, c, d, 0, 3);
    d = r2(d, a, b, c, 4, 5);
    c = r2(c, d, a, b, 8, 9);
    b = r2(b, c, d, a, 12, 13);
    a = r2(a, b, c, d, 1, 3);
    d = r2(d, a, b, c, 5, 5);
    c = r2(c, d, a, b, 9, 9);
    b = r2(b, c, d, a, 13, 13);
    a = r2(a, b, c, d, 2, 3);
    d = r2(d, a, b, c, 6, 5);
    c = r2(c, d, a, b, 10, 9);
    b = r2(b, c, d, a, 14, 13);
    a = r2(a, b, c, d, 3, 3);
    d = r2(d, a, b, c, 7, 5);
    c = r2(c, d, a, b, 11, 9);
    b = r2(b, c, d, a, 15, 13);

    const r3 = (p: number, q: number, r: number, s: number, k: number, shift: number): number =>
      rotl(add(p, H(q, r, s), X[k]!, 0x6ed9eba1), shift);
    a = r3(a, b, c, d, 0, 3);
    d = r3(d, a, b, c, 8, 9);
    c = r3(c, d, a, b, 4, 11);
    b = r3(b, c, d, a, 12, 15);
    a = r3(a, b, c, d, 2, 3);
    d = r3(d, a, b, c, 10, 9);
    c = r3(c, d, a, b, 6, 11);
    b = r3(b, c, d, a, 14, 15);
    a = r3(a, b, c, d, 1, 3);
    d = r3(d, a, b, c, 9, 9);
    c = r3(c, d, a, b, 5, 11);
    b = r3(b, c, d, a, 13, 15);
    a = r3(a, b, c, d, 3, 3);
    d = r3(d, a, b, c, 11, 9);
    c = r3(c, d, a, b, 7, 11);
    b = r3(b, c, d, a, 15, 15);

    a = add(a, aa);
    b = add(b, bb);
    c = add(c, cc);
    d = add(d, dd);
  }

  const out = Buffer.alloc(16);
  out.writeUInt32LE(a >>> 0, 0);
  out.writeUInt32LE(b >>> 0, 4);
  out.writeUInt32LE(c >>> 0, 8);
  out.writeUInt32LE(d >>> 0, 12);
  return out;
}
