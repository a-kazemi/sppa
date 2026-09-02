import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAccess,
  grantedKinds,
  hasPermission,
  isEmptyMask,
  isFullControl,
  parseMask,
  PermissionKind,
} from '../src/sp/permissions';

test('parseMask accepts strings and numbers', () => {
  assert.deepEqual(parseMask({ High: '0', Low: '65537' }), { high: 0, low: 65537 });
  assert.deepEqual(parseMask({ High: 1, Low: 2 }), { high: 1, low: 2 });
  assert.deepEqual(parseMask(undefined), { high: 0, low: 0 });
});

test('isFullControl only for all-bits-set', () => {
  assert.ok(isFullControl({ high: 0x7fffffff, low: 0xffffffff }));
  assert.ok(!isFullControl({ high: 0x7fffffff, low: 0xfffffffe }));
  assert.equal(grantedKinds({ high: 0x7fffffff, low: 0xffffffff })[0], 'FullControl');
});

test('hasPermission indexes bits across both halves', () => {
  const readish = { high: 0, low: (1 << 0) | (1 << 16) }; // ViewListItems + Open
  assert.ok(hasPermission(readish, PermissionKind['ViewListItems']!));
  assert.ok(hasPermission(readish, PermissionKind['Open']!));
  assert.ok(!hasPermission(readish, PermissionKind['EditListItems']!));

  const bit31 = { high: 0, low: 0x80000000 }; // UseClientIntegration == index 32
  assert.ok(hasPermission(bit31, 32));

  const highBit = { high: 1, low: 0 }; // index 33 -> high bit 0
  assert.ok(hasPermission(highBit, 33));
});

test('canAccess / isEmptyMask', () => {
  assert.ok(isEmptyMask({ high: 0, low: 0 }));
  assert.ok(!canAccess({ high: 0, low: 0 }));
  assert.ok(canAccess({ high: 0, low: 1 << 16 })); // Open
  assert.ok(canAccess({ high: 0x7fffffff, low: 0xffffffff }));
});

test('grantedKinds lists reportable labels', () => {
  const mask = { high: 0, low: (1 << 0) | (1 << 16) | (1 << 17) };
  const kinds = grantedKinds(mask);
  assert.ok(kinds.includes('ViewListItems'));
  assert.ok(kinds.includes('Open'));
  assert.ok(kinds.includes('ViewPages'));
});
