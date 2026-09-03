import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScan, mergeScanReports, ScanInput } from '../src/analysis/scanSite';
import { Principal, PrincipalType, RoleAssignment } from '../src/sp/principals';

const SID = 'S-1-5-21-1004336348-1177238915-682003330-1099';

function ra(p: Partial<RoleAssignment>): RoleAssignment {
  return { principalId: 0, principalType: PrincipalType.User, principalTitle: '', principalLoginName: '', roles: [], ...p };
}
function user(p: Partial<Principal>): Principal {
  return { id: 1, loginName: '', title: '', email: '', principalType: PrincipalType.User, isSiteAdmin: false, ...p };
}

function baseInput(): ScanInput {
  return {
    web: {
      title: 'HR',
      url: 'https://sp/sites/hr',
      hasUniqueRoleAssignments: true,
      assignments: [
        ra({ principalId: 3, principalType: PrincipalType.SharePointGroup, principalTitle: 'HR Members', roles: ['Read'] }),
        ra({ principalId: 4, principalLoginName: 'c:0(.s|true', principalTitle: 'Everyone', roles: ['Read', 'Limited Access'] }),
      ],
    },
    lists: [
      {
        id: '1',
        title: 'Salaries',
        hasUniqueRoleAssignments: true,
        baseTemplate: 100,
        itemCount: 2,
        assignments: [ra({ principalId: 10, principalType: PrincipalType.User, principalTitle: 'Bob', roles: ['Full Control'] })],
        uniqueItems: [{ id: 7, fileRef: '/sites/hr/Salaries/7', assignments: [ra({ principalId: 12, principalTitle: 'Carol', roles: ['Contribute'] })] }],
      },
      {
        id: '2',
        title: 'Shared Documents',
        hasUniqueRoleAssignments: false,
        baseTemplate: 101,
        itemCount: 0,
        assignments: [],
        uniqueItems: [],
      },
    ],
    siteUsers: [
      user({ id: 20, title: 'Jane Doe', loginName: 'i:0#.w|contoso\\jane', email: 'jane@contoso.com' }),
      user({ id: 21, title: SID, loginName: `i:0#.w|contoso\\${SID}` }),
      user({ id: 22, title: 'Admin', loginName: 'i:0#.w|contoso\\admin', isSiteAdmin: true }),
    ],
    siteGroups: [
      { id: 3, title: 'HR Members', ownerTitle: 'Admin', users: [user({ id: 20 }), user({ id: 23 }), user({ id: 24 }), user({ id: 25 }) ] },
      { id: 9, title: 'Small Group', ownerTitle: 'Admin', users: [user({ id: 20 })] },
    ],
    largeGroupThreshold: 3,
  };
}

test('scan report summary counts', () => {
  const r = analyzeScan(baseInput());
  assert.equal(r.summary.listsScanned, 2);
  assert.equal(r.summary.listsWithUniquePermissions, 1);
  assert.equal(r.summary.itemsWithUniquePermissions, 1);
  assert.equal(r.summary.orphanedPrincipals, 1);
  assert.equal(r.summary.broadGrants, 1);
  assert.equal(r.summary.largeGroups, 1);
  assert.equal(r.summary.siteCollectionAdmins, 1);
});

test('broken inheritance lists web, list and item scopes', () => {
  const r = analyzeScan(baseInput());
  const kinds = r.brokenInheritance.map((b) => b.kind).sort();
  assert.deepEqual(kinds, ['item', 'list', 'web']);
});

test('broad grant drops Limited Access from the reported roles', () => {
  const r = analyzeScan(baseInput());
  assert.equal(r.broadGrants[0]!.audience, 'Everyone');
  assert.deepEqual(r.broadGrants[0]!.roles, ['Read']);
});

test('orphan is linked to the ACLs it sits on', () => {
  const input = baseInput();
  input.web.assignments.push(
    ra({ principalId: 21, principalType: PrincipalType.User, principalTitle: SID, principalLoginName: `i:0#.w|contoso\\${SID}`, roles: ['Read'] }),
  );
  const r = analyzeScan(input);
  assert.equal(r.orphanedPrincipals.length, 1);
  assert.equal(r.orphanedPrincipals[0]!.confidence, 'high');
  assert.ok(r.orphanedPrincipals[0]!.onAcl.includes('HR'));
});

test('largeGroupThreshold is inclusive and sorted by size', () => {
  const r = analyzeScan(baseInput());
  assert.equal(r.largeGroups.length, 1);
  assert.equal(r.largeGroups[0]!.title, 'HR Members');
  assert.equal(r.largeGroups[0]!.memberCount, 4);
});

test('webUrl stamps every finding for a recursive scan', () => {
  const input = baseInput();
  input.webUrl = '/sites/hr/team';
  const r = analyzeScan(input);
  assert.ok(r.brokenInheritance.every((b) => b.web === '/sites/hr/team'));
  assert.ok(r.largeGroups.every((g) => g.web === '/sites/hr/team'));
});

test('a single-web scan leaves findings unstamped', () => {
  const r = analyzeScan(baseInput());
  assert.ok(r.brokenInheritance.every((b) => b.web === undefined));
  assert.equal(r.websScanned, undefined);
});

test('mergeScanReports sums counts, concatenates findings, dedupes admins', () => {
  const root = analyzeScan({ ...baseInput(), webUrl: '/sites/hr' });
  const sub = analyzeScan({ ...baseInput(), webUrl: '/sites/hr/team' });
  const merged = mergeScanReports([root, sub]);
  assert.equal(merged.websScanned, 2);
  assert.equal(merged.summary.listsScanned, root.summary.listsScanned + sub.summary.listsScanned);
  assert.equal(merged.brokenInheritance.length, root.brokenInheritance.length + sub.brokenInheritance.length);
  // Same admin ("Admin") appears in both per-web reports but only once merged.
  assert.equal(merged.siteCollectionAdmins.length, 1);
  assert.equal(merged.summary.siteCollectionAdmins, 1);
});

test('mergeScanReports of one report just tags websScanned = 1', () => {
  const only = analyzeScan(baseInput());
  const merged = mergeScanReports([only]);
  assert.equal(merged.websScanned, 1);
  assert.deepEqual(merged.brokenInheritance, only.brokenInheritance);
});
