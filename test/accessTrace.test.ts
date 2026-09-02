import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccessTrace, ScopeNode } from '../src/analysis/accessTrace';
import { PrincipalType, Principal, RoleAssignment } from '../src/sp/principals';
import { PermMask } from '../src/sp/permissions';

const OPEN_MASK: PermMask = { high: 0, low: (1 << 0) | (1 << 16) }; // ViewListItems + Open
const EMPTY_MASK: PermMask = { high: 0, low: 0 };
const FULL_MASK: PermMask = { high: 0x7fffffff, low: 0xffffffff };

const jane: Principal = {
  id: 11,
  loginName: 'i:0#.w|contoso\\jane',
  title: 'Jane Doe',
  email: 'jane@contoso.com',
  principalType: PrincipalType.User,
  isSiteAdmin: false,
};

function ra(p: Partial<RoleAssignment>): RoleAssignment {
  return {
    principalId: 0,
    principalType: PrincipalType.User,
    principalTitle: '',
    principalLoginName: '',
    roles: [],
    ...p,
  };
}

function web(assignments: RoleAssignment[], unique = false): ScopeNode {
  return { kind: 'web', title: 'HR', url: 'https://sp/sites/hr', hasUniqueRoleAssignments: unique, assignments };
}

test('direct grant on an inherited web', () => {
  const r = buildAccessTrace({
    user: jane,
    effectiveMask: OPEN_MASK,
    userGroupIds: [],
    path: [web([ra({ principalId: 11, principalType: PrincipalType.User, principalTitle: 'Jane Doe', roles: ['Read'] })])],
    isSiteCollectionAdmin: false,
  });
  assert.ok(r.hasAccess);
  assert.equal(r.brokenInheritanceAt.length, 0);
  assert.equal(r.grantPaths.length, 1);
  assert.equal(r.grantPaths[0]!.channel, 'direct');
  assert.deepEqual(r.grantPaths[0]!.roles, ['Read']);
});

test('grant via SharePoint group with inheritance broken at the list', () => {
  const list: ScopeNode = {
    kind: 'list',
    title: 'Salaries',
    hasUniqueRoleAssignments: true,
    assignments: [ra({ principalId: 5, principalType: PrincipalType.SharePointGroup, principalTitle: 'HR Owners', roles: ['Contribute'] })],
  };
  const r = buildAccessTrace({
    user: jane,
    effectiveMask: OPEN_MASK,
    userGroupIds: [5],
    path: [web([]), list],
    isSiteCollectionAdmin: false,
  });
  assert.equal(r.grantPaths.length, 1);
  assert.equal(r.grantPaths[0]!.channel, 'sharepoint-group');
  assert.equal(r.grantPaths[0]!.via, 'HR Owners');
  assert.deepEqual(r.brokenInheritanceAt, [{ kind: 'list', title: 'Salaries' }]);
});

test('no access -> empty permissions note', () => {
  const r = buildAccessTrace({
    user: jane,
    effectiveMask: EMPTY_MASK,
    userGroupIds: [],
    path: [web([])],
    isSiteCollectionAdmin: false,
  });
  assert.equal(r.hasAccess, false);
  assert.ok(r.notes.some((n) => /no access/i.test(n)));
});

test('site collection administrator overrides everything', () => {
  const r = buildAccessTrace({
    user: { ...jane, isSiteAdmin: true },
    effectiveMask: EMPTY_MASK,
    userGroupIds: [],
    path: [web([])],
    isSiteCollectionAdmin: true,
  });
  assert.ok(r.hasAccess);
  assert.ok(r.siteCollectionAdmin);
  assert.ok(r.notes.some((n) => /Site Collection Administrator/i.test(n)));
});

test('unresolved AD group is surfaced but marked uncertain', () => {
  const r = buildAccessTrace({
    user: jane,
    effectiveMask: FULL_MASK,
    userGroupIds: [],
    path: [web([ra({ principalId: 99, principalType: PrincipalType.SecurityGroup, principalTitle: 'CONTOSO\\HR-Staff', roles: ['Full Control'] })])],
    isSiteCollectionAdmin: false,
  });
  assert.ok(r.fullControl);
  assert.equal(r.unresolvedGroups.length, 1);
  assert.equal(r.grantPaths[0]!.channel, 'ad-group-unresolved');
  assert.equal(r.grantPaths[0]!.certain, false);
});
