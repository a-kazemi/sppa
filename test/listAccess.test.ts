import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeListAccess, ListAccessInput } from '../src/analysis/listAccess';
import { Principal, PrincipalType, RoleAssignment } from '../src/sp/principals';

function ra(p: Partial<RoleAssignment>): RoleAssignment {
  return { principalId: 0, principalType: PrincipalType.User, principalTitle: '', principalLoginName: '', roles: [], ...p };
}
function user(p: Partial<Principal>): Principal {
  return { id: 1, loginName: '', title: '', email: '', principalType: PrincipalType.User, isSiteAdmin: false, ...p };
}

function baseInput(over: Partial<ListAccessInput> = {}): ListAccessInput {
  return {
    scope: { kind: 'web', title: 'Human Resources', url: 'https://sp/sites/hr' },
    inheritedFromParent: false,
    governingScopeTitle: 'Human Resources',
    assignments: [
      ra({ principalId: 3, principalType: PrincipalType.SharePointGroup, principalTitle: 'HR Members', principalLoginName: 'hr members', roles: ['Contribute', 'Limited Access'] }),
      ra({ principalId: 5, principalType: PrincipalType.User, principalTitle: 'Direct Dan', principalLoginName: 'i:0#.w|contoso\\dan', roles: ['Read'] }),
      ra({ principalId: 7, principalType: PrincipalType.SecurityGroup, principalTitle: 'CONTOSO\\HR-Admins', principalLoginName: 'c:0+.w|s-1-5-21-5-7', roles: ['Full Control'] }),
      ra({ principalId: 9, principalLoginName: 'c:0(.s|true', principalTitle: 'Everyone', roles: ['Read', 'Limited Access'] }),
    ],
    groupMembers: new Map([
      [3, [user({ id: 20, title: 'Jane Doe', loginName: 'i:0#.w|contoso\\jane', email: 'jane@contoso.com' }), user({ id: 21, title: 'Ann Lee', loginName: 'i:0#.w|contoso\\ann' })]],
    ]),
    emailByLogin: new Map([['i:0#.w|contoso\\ann', 'ann@contoso.com']]),
    siteCollectionAdmins: [{ loginName: 'i:0#.w|contoso\\mark', title: 'Mark Adams' }],
    ...over,
  };
}

test('expands SharePoint groups to members and drops Limited Access', () => {
  const r = analyzeListAccess(baseInput());
  const jane = r.entries.find((e) => e.name === 'Jane Doe');
  assert.ok(jane);
  assert.equal(jane!.kind, 'user');
  assert.deepEqual(jane!.roles, ['Contribute']);
  assert.equal(jane!.via, 'HR Members');
  assert.equal(jane!.email, 'jane@contoso.com');
});

test('enriches member email from the site-user index when the group payload lacks it', () => {
  const r = analyzeListAccess(baseInput());
  const ann = r.entries.find((e) => e.name === 'Ann Lee');
  assert.equal(ann!.email, 'ann@contoso.com');
});

test('direct user grants are marked as direct (no via)', () => {
  const r = analyzeListAccess(baseInput());
  const dan = r.entries.find((e) => e.name === 'Direct Dan');
  assert.equal(dan!.kind, 'user');
  assert.equal(dan!.via, undefined);
});

test('AD security groups and broad audiences are reported as unexpandable', () => {
  const r = analyzeListAccess(baseInput());
  const ad = r.entries.find((e) => e.kind === 'ad-group');
  const broad = r.entries.find((e) => e.kind === 'broad-audience');
  assert.equal(ad!.name, 'CONTOSO\\HR-Admins');
  assert.equal(ad!.expandable, false);
  assert.equal(broad!.name, 'Everyone');
  assert.equal(broad!.expandable, false);
  assert.ok(r.notes.some((n) => /AD security group/.test(n)));
});

test('principalCount is distinct users plus each unexpandable entry', () => {
  const r = analyzeListAccess(baseInput());
  // Jane + Ann + Dan = 3 users, + HR-Admins + Everyone = 5
  assert.equal(r.principalCount, 5);
});

test('a user in two groups is merged once with unioned roles and both vias', () => {
  const input = baseInput();
  input.assignments.push(
    ra({ principalId: 4, principalType: PrincipalType.SharePointGroup, principalTitle: 'HR Owners', principalLoginName: 'hr owners', roles: ['Full Control'] }),
  );
  input.groupMembers.set(4, [user({ id: 20, title: 'Jane Doe', loginName: 'i:0#.w|contoso\\jane' })]);
  const r = analyzeListAccess(input);
  const janes = r.entries.filter((e) => e.name === 'Jane Doe');
  assert.equal(janes.length, 1);
  assert.deepEqual(janes[0]!.roles.sort(), ['Contribute', 'Full Control']);
  assert.equal(janes[0]!.via, 'HR Members, HR Owners');
});

test('inherited list scope is flagged with a note pointing at the parent', () => {
  const r = analyzeListAccess(
    baseInput({
      scope: { kind: 'list', title: 'Public Docs' },
      inheritedFromParent: true,
      governingScopeTitle: 'Human Resources',
    }),
  );
  assert.equal(r.inheritedFromParent, true);
  assert.ok(r.notes.some((n) => /inherits permissions from "Human Resources"/.test(n)));
});
