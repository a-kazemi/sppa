import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildType1Message,
  buildType3Message,
  ntowfv2,
  parseType2Message,
  windowsTimestamp,
} from '../src/auth/ntlm';

/**
 * Test vectors from [MS-NLMP] 4.2.4 "NTLMv2 Authentication":
 *   User="User", Domain="Domain", Password="Password"
 *   Server challenge = 0x0123456789abcdef
 *   Client challenge = 0xaaaaaaaaaaaaaaaa
 *   Timestamp        = 0
 */
const TARGET_INFO = Buffer.from(
  '0200' + '0c00' + Buffer.from('Domain', 'utf16le').toString('hex') +
    '0100' + '0c00' + Buffer.from('Server', 'utf16le').toString('hex') +
    '0000' + '0000',
  'hex',
);

test('ntowfv2 matches MS-NLMP 4.2.4.1.1', () => {
  assert.equal(
    ntowfv2('User', 'Password', 'Domain').toString('hex'),
    '0c868a403bfd7a93a3001ef22ef02e3f',
  );
});

test('buildType3Message reproduces the MS-NLMP NTProofStr', () => {
  const type2 = {
    serverChallenge: Buffer.from('0123456789abcdef', 'hex'),
    flags: 0,
    targetInfo: TARGET_INFO,
  };
  const res = buildType3Message(type2, {
    user: 'User',
    password: 'Password',
    domain: 'Domain',
    workstation: 'COMPUTER',
    clientChallenge: Buffer.alloc(8, 0xaa),
    timestamp: Buffer.alloc(8, 0),
  });
  assert.equal(res.ntProof.toString('hex'), '68cd0ab851e51c96aabc927bebef6a1c');
  // NT response = NTProofStr || temp; temp starts with the blob header.
  assert.equal(res.ntResponse.subarray(0, 16).toString('hex'), res.ntProof.toString('hex'));
  assert.equal(res.ntResponse.subarray(16, 24).toString('hex'), '0101000000000000');
});

test('type 1 message is well formed', () => {
  const t1 = buildType1Message();
  assert.equal(t1.subarray(0, 8).toString('latin1'), 'NTLMSSP\0');
  assert.equal(t1.readUInt32LE(8), 1);
  // DomainName / Workstation security buffers: empty, but offset past the header.
  assert.equal(t1.readUInt16LE(16), 0, 'DomainName Len = 0');
  assert.equal(t1.readUInt32LE(20), 40, 'DomainName BufferOffset = 40');
  assert.equal(t1.readUInt16LE(24), 0, 'Workstation Len = 0');
  assert.equal(t1.readUInt32LE(28), 40, 'Workstation BufferOffset = 40');
});

test('parseType2Message round-trips a synthetic challenge', () => {
  // Minimal Type 2: signature + type + no target name + flags + challenge + reserved.
  const buf = Buffer.alloc(32);
  Buffer.from('NTLMSSP\0', 'latin1').copy(buf, 0);
  buf.writeUInt32LE(2, 8);
  buf.writeUInt32LE(0x00080000, 20);
  Buffer.from('1122334455667788', 'hex').copy(buf, 24);
  const parsed = parseType2Message(buf);
  assert.equal(parsed.serverChallenge.toString('hex'), '1122334455667788');
  assert.equal(parsed.flags, 0x00080000);
});

test('windowsTimestamp encodes the FILETIME epoch offset', () => {
  assert.equal(windowsTimestamp(0).readBigUInt64LE(), 116444736000000000n);
});
