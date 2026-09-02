import test from 'node:test';
import assert from 'node:assert/strict';
import { md4 } from '../src/auth/md4';

const hex = (s: string): string => md4(Buffer.from(s, 'latin1')).toString('hex');

test('md4 matches RFC 1320 test vectors', () => {
  assert.equal(hex(''), '31d6cfe0d16ae931b73c59d7e0c089c0');
  assert.equal(hex('a'), 'bde52cb31de33e46245e05fbdbd6fb24');
  assert.equal(hex('abc'), 'a448017aaf21d8525fc10ae87aa6729d');
  assert.equal(hex('message digest'), 'd9130a8164549fe818874806e1c7014b');
  assert.equal(
    hex('abcdefghijklmnopqrstuvwxyz'),
    'd79e1c308aa5bbcdeea8ed63df412da9',
  );
});

test('md4 of a message spanning multiple 64-byte blocks', () => {
  assert.equal(
    hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890'),
    'e33b4ddc9c38f2199c3e7b164fcc0536',
  );
});
