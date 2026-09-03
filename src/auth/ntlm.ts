/**
 * Minimal NTLMv2 message construction for HTTP authentication (MS-NLMP).
 *
 * Scope for v1 (deliberately narrow — see docs/AUTH.md):
 *   - NTLM with explicit credentials only.
 *   - NTLMv2 response + LMv2 response.
 *   - No message signing/sealing, no session key export, no channel binding.
 *   - No AD FS (WS-Federation) and no Forms-Based Auth. Those are separate,
 *     much larger handshakes and are intentionally out of scope until a real
 *     user asks for them.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { md4 } from './md4';

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');

// NTLMSSP negotiate flags we advertise in the Type 1 message.
const NEGOTIATE_UNICODE = 0x00000001;
const NEGOTIATE_OEM = 0x00000002;
const REQUEST_TARGET = 0x00000004;
const NEGOTIATE_NTLM = 0x00000200;
const NEGOTIATE_ALWAYS_SIGN = 0x00008000;
const NEGOTIATE_EXTENDED_SESSIONSECURITY = 0x00080000;
const NEGOTIATE_VERSION = 0x02000000;
const NEGOTIATE_128 = 0x20000000;
const NEGOTIATE_56 = 0x80000000;

const TYPE1_FLAGS =
  (NEGOTIATE_UNICODE |
    NEGOTIATE_OEM |
    REQUEST_TARGET |
    NEGOTIATE_NTLM |
    NEGOTIATE_ALWAYS_SIGN |
    NEGOTIATE_EXTENDED_SESSIONSECURITY |
    NEGOTIATE_VERSION |
    NEGOTIATE_128 |
    NEGOTIATE_56) >>>
  0;

const TYPE3_FLAGS =
  (NEGOTIATE_UNICODE |
    REQUEST_TARGET |
    NEGOTIATE_NTLM |
    NEGOTIATE_ALWAYS_SIGN |
    NEGOTIATE_EXTENDED_SESSIONSECURITY |
    NEGOTIATE_128 |
    NEGOTIATE_56) >>>
  0;

export interface Type2Message {
  /** 8-byte server challenge. */
  serverChallenge: Buffer;
  /** Negotiate flags the server echoed back. */
  flags: number;
  /** Raw TargetInfo (AV_PAIR) block, or empty buffer when absent. */
  targetInfo: Buffer;
}

function utf16le(s: string): Buffer {
  return Buffer.from(s, 'utf16le');
}

/** Build the NTLM Type 1 (NEGOTIATE) message. */
export function buildType1Message(): Buffer {
  const buf = Buffer.alloc(40);
  SIGNATURE.copy(buf, 0);
  buf.writeUInt32LE(1, 8); // message type
  buf.writeUInt32LE(TYPE1_FLAGS, 12);
  // DomainName (offset 16) and Workstation (offset 24) security-buffer fields.
  // We supply neither, so Len and MaxLen stay 0, but MS-NLMP 2.2.1.1 still wants
  // BufferOffset to point just past the fixed portion (40) rather than be 0 —
  // strict proxies reject a zero offset.
  buf.writeUInt32LE(40, 20); // DomainName BufferOffset
  buf.writeUInt32LE(40, 28); // Workstation BufferOffset
  // Version (8 bytes) at offset 32: report a generic Windows build.
  buf[32] = 6; // major
  buf[33] = 1; // minor
  buf.writeUInt16LE(7601, 34); // build
  buf[39] = 0x0f; // NTLM revision current
  return buf;
}

/** Parse an NTLM Type 2 (CHALLENGE) message received from the server. */
export function parseType2Message(buf: Buffer): Type2Message {
  if (buf.length < 32 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Malformed NTLM Type 2 message (bad signature or too short)');
  }
  const type = buf.readUInt32LE(8);
  if (type !== 2) {
    throw new Error(`Expected NTLM Type 2 message, got type ${type}`);
  }
  const flags = buf.readUInt32LE(20);
  const serverChallenge = Buffer.from(buf.subarray(24, 32));

  let targetInfo = Buffer.alloc(0);
  if (buf.length >= 48) {
    const tiLen = buf.readUInt16LE(40);
    const tiOffset = buf.readUInt32LE(44);
    if (tiLen > 0 && tiOffset + tiLen <= buf.length) {
      targetInfo = Buffer.from(buf.subarray(tiOffset, tiOffset + tiLen));
    }
  }
  return { serverChallenge, flags, targetInfo };
}

/** NTOWFv2 = HMAC_MD5(MD4(UTF16LE(password)), UTF16LE(uppercase(user) + domain)). */
export function ntowfv2(user: string, password: string, domain: string): Buffer {
  const ntHash = md4(utf16le(password));
  return createHmac('md5', ntHash)
    .update(utf16le(user.toUpperCase() + domain))
    .digest();
}

/** Windows FILETIME (100ns ticks since 1601-01-01) for a given epoch ms. */
export function windowsTimestamp(epochMs: number): Buffer {
  const ticks = BigInt(epochMs) * 10000n + 116444736000000000n;
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(ticks);
  return b;
}

export interface Type3Options {
  user: string;
  password: string;
  domain: string;
  workstation: string;
  /** Override the client challenge (tests only). */
  clientChallenge?: Buffer;
  /** Override the timestamp buffer (tests only). */
  timestamp?: Buffer;
}

export interface Type3Result {
  message: Buffer;
  ntProof: Buffer;
  ntResponse: Buffer;
  lmResponse: Buffer;
}

/**
 * Build the NTLM Type 3 (AUTHENTICATE) message in response to a Type 2 challenge.
 */
export function buildType3Message(type2: Type2Message, opts: Type3Options): Type3Result {
  const clientChallenge = opts.clientChallenge ?? randomBytes(8);
  const timestamp = opts.timestamp ?? windowsTimestamp(Date.now());
  const responseKey = ntowfv2(opts.user, opts.password, opts.domain);

  // "temp" blob (MS-NLMP 3.3.2).
  const blobHeader = Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const reserved4 = Buffer.alloc(4);
  const temp = Buffer.concat([
    blobHeader,
    timestamp,
    clientChallenge,
    reserved4,
    type2.targetInfo,
    reserved4,
  ]);

  const ntProof = createHmac('md5', responseKey)
    .update(Buffer.concat([type2.serverChallenge, temp]))
    .digest();
  const ntResponse = Buffer.concat([ntProof, temp]);

  const lmProof = createHmac('md5', responseKey)
    .update(Buffer.concat([type2.serverChallenge, clientChallenge]))
    .digest();
  const lmResponse = Buffer.concat([lmProof, clientChallenge]);

  const domainBuf = utf16le(opts.domain);
  const userBuf = utf16le(opts.user);
  const wsBuf = utf16le(opts.workstation);
  const sessionKey = Buffer.alloc(0);

  const HEADER_LEN = 72; // includes 8-byte version block
  let offset = HEADER_LEN;
  const payloadParts: Buffer[] = [];

  const field = (data: Buffer): Buffer => {
    const f = Buffer.alloc(8);
    f.writeUInt16LE(data.length, 0);
    f.writeUInt16LE(data.length, 2);
    f.writeUInt32LE(offset, 4);
    payloadParts.push(data);
    offset += data.length;
    return f;
  };

  const lmField = field(lmResponse);
  const ntField = field(ntResponse);
  const domainField = field(domainBuf);
  const userField = field(userBuf);
  const wsField = field(wsBuf);
  const sessionField = field(sessionKey);

  const header = Buffer.alloc(HEADER_LEN);
  SIGNATURE.copy(header, 0);
  header.writeUInt32LE(3, 8); // message type
  lmField.copy(header, 12);
  ntField.copy(header, 20);
  domainField.copy(header, 28);
  userField.copy(header, 36);
  wsField.copy(header, 44);
  sessionField.copy(header, 52);
  header.writeUInt32LE(TYPE3_FLAGS, 60);
  // Version block (offset 64).
  header[64] = 6;
  header[65] = 1;
  header.writeUInt16LE(7601, 66);
  header[71] = 0x0f;

  return {
    message: Buffer.concat([header, ...payloadParts]),
    ntProof,
    ntResponse,
    lmResponse,
  };
}
