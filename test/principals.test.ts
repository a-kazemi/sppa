import test from 'node:test';
import assert from 'node:assert/strict';
import {
  broadAudienceLabel,
  classifyOrphan,
  looksLikeSid,
  Principal,
  PrincipalType,
  sidFromLogin,
} from '../src/sp/principals';

const SID = 'S-1-5-21-1004336348-1177238915-682003330-1013';

function principal(p: Partial<Principal>): Principal {
  return {
    id: 1,
    loginName: '',
    title: '',
    email: '',
    principalType: PrincipalType.User,
    isSiteAdmin: false,
    ...p,
  };
}

test('looksLikeSid / sidFromLogin', () => {
  assert.ok(looksLikeSid(SID));
  assert.ok(!looksLikeSid('CONTOSO\\a.kazemi'));
  assert.equal(sidFromLogin(`i:0#.w|contoso\\${SID}`), SID);
  assert.equal(sidFromLogin('i:0#.w|contoso\\a.kazemi'), null);
});

test('classifyOrphan flags unresolved SID accounts', () => {
  const high = classifyOrphan(
    principal({ principalType: PrincipalType.User, title: SID, loginName: `i:0#.w|contoso\\${SID}` }),
  );
  assert.equal(high?.confidence, 'high');

  const medium = classifyOrphan(
    principal({ principalType: PrincipalType.SecurityGroup, title: '', email: '', loginName: `i:0#.w|contoso\\${SID}` }),
  );
  assert.equal(medium?.confidence, 'medium');
});

test('classifyOrphan ignores healthy users and SharePoint groups', () => {
  assert.equal(
    classifyOrphan(principal({ title: 'Jane Doe', email: 'jane@contoso.com', loginName: 'i:0#.w|contoso\\a.kazemi' })),
    null,
  );
  assert.equal(
    classifyOrphan(principal({ principalType: PrincipalType.SharePointGroup, title: SID })),
    null,
  );
});

test('broadAudienceLabel recognises wide claims', () => {
  assert.equal(broadAudienceLabel('c:0(.s|true'), 'Everyone');
  assert.equal(broadAudienceLabel('c:0!.s|windows'), 'All authenticated Windows users');
  assert.equal(broadAudienceLabel('NT AUTHORITY\\authenticated users'), 'All authenticated Windows users');
  assert.equal(broadAudienceLabel('i:0#.w|contoso\\a.kazemi'), null);
});
