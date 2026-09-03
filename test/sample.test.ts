/**
 * End-to-end fixture test: drive the real `_api` parsing layer (SharePointClient)
 * against a synthetic farm recorded under `sample/api/`, run the real analysis
 * and JSON/table renderers, and check the committed worked example in `sample/`
 * still matches. This is the regression harness the pre-mortem asks for (F4): it
 * exercises the recorded `_api` response shapes → parsed model → report pipeline
 * without a live SharePoint farm and without any production code change.
 *
 * The NTLM handshake itself is still unproven — that needs a real farm.
 *
 * Regenerate the committed sample outputs after an intentional change:
 *   UPDATE_SAMPLES=1 npm run test:only
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { NtlmHttpClient, HttpResponse } from '../src/auth/httpClient';
import { SharePointClient } from '../src/sp/client';
import { analyzeScan, ScanInput } from '../src/analysis/scanSite';
import { buildAccessTrace, ScopeNode } from '../src/analysis/accessTrace';
import { renderScanReport, renderAccessTrace } from '../src/report/table';
import { renderJson, toJsonEnvelope } from '../src/report/json';

const SITE = 'https://sp.contoso.local/sites/hr';
const JANE = 'i:0#.w|contoso\\jane';
const RLEE = 'i:0#.w|contoso\\rlee';
const DENY_LIST = 'Salaries';
const SAMPLE_DIR = path.resolve(__dirname, '../../sample');
const API_DIR = path.join(SAMPLE_DIR, 'api');
const UPDATE = Boolean(process.env['UPDATE_SAMPLES']);

/** Map a recorded `_api` request URL to a fixture file under sample/api/. */
function fixtureFor(url: string): string {
  const afterApi = url.split('/_api/')[1] ?? '';
  const [rawPathRaw = '', query = ''] = afterApi.split('?');
  const rawPath = decodeURIComponent(rawPathRaw);

  const listItemRa = rawPath.match(/^web\/lists\/getByTitle\('(.+)'\)\/items\((\d+)\)\/roleassignments$/);
  if (listItemRa) return `list_${listItemRa[1]}_item_${listItemRa[2]}_roleassignments.json`;

  const listEffPerms = rawPath.match(/^web\/lists\/getByTitle\('(.+)'\)\/getUserEffectivePermissions/);
  if (listEffPerms) return `list_${listEffPerms[1]}_getUserEffectivePermissions.json`;

  const listItems = rawPath.match(/^web\/lists\/getByTitle\('(.+)'\)\/items$/);
  if (listItems) return `list_${listItems[1]}_items.json`;

  const listRa = rawPath.match(/^web\/lists\/getByTitle\('(.+)'\)\/roleassignments$/);
  if (listRa) return `list_${listRa[1]}_roleassignments.json`;

  const userGroups = rawPath.match(/^web\/getUserById\((\d+)\)\/groups$/);
  if (userGroups) return `web_getUserById_${userGroups[1]}_groups.json`;

  if (/^web\/getUserEffectivePermissions/.test(rawPath)) return 'web_getUserEffectivePermissions.json';
  if (rawPath === 'web/roleassignments') return 'web_roleassignments.json';
  if (rawPath === 'web/siteusers') return 'web_siteusers.json';
  if (rawPath === 'web/sitegroups') return 'web_sitegroups.json';
  if (rawPath === 'web/lists') return 'web_lists.json';
  if (rawPath === 'web') return 'web.json';

  throw new Error(`no fixture mapped for _api path: ${rawPath} (query: ${query})`);
}

/** A stand-in for NtlmHttpClient that serves the recorded fixtures. */
class ReplayHttpClient {
  request(opts: { url: string }): Promise<HttpResponse> {
    const file = fixtureFor(opts.url);
    let body = fs.readFileSync(path.join(API_DIR, file), 'utf8');

    // Honour the $filter=LoginName eq '...' clause that findUser() relies on.
    const filter = opts.url.match(/\$filter=LoginName eq '([^']*)'/);
    if (filter) {
      const wanted = decodeURIComponent(filter[1]!).toLowerCase();
      const parsed = JSON.parse(body) as { value: Array<{ LoginName: string }> };
      parsed.value = parsed.value.filter((u) => u.LoginName.toLowerCase() === wanted);
      body = JSON.stringify(parsed);
    }

    return Promise.resolve({ status: 200, headers: {}, body: Buffer.from(body, 'utf8') });
  }
  destroy(): void {}
}

function client(): SharePointClient {
  return new SharePointClient(new ReplayHttpClient() as unknown as NtlmHttpClient, SITE);
}

/** Mirror of commands/scanSite.ts orchestration (defaults, no progress sink). */
async function runScan(): Promise<string> {
  const sp = client();
  const web = await sp.connect();
  const [webAssignments, siteUsers, siteGroups, lists] = await Promise.all([
    sp.getWebRoleAssignments(),
    sp.getSiteUsers(),
    sp.getSiteGroupsWithUsers(),
    sp.getLists(false),
  ]);
  const analyzedLists: ScanInput['lists'] = [];
  for (const list of lists) {
    const assignments = list.hasUniqueRoleAssignments ? await sp.getListRoleAssignments(list.title) : [];
    const uniqueItems = list.itemCount > 0 ? await sp.getUniqueItems(list.title, 20000) : [];
    analyzedLists.push({ ...list, assignments, uniqueItems });
  }
  const report = analyzeScan({
    web: {
      title: web.title,
      url: web.url,
      hasUniqueRoleAssignments: web.hasUniqueRoleAssignments,
      assignments: webAssignments,
    },
    lists: analyzedLists,
    siteUsers,
    siteGroups,
    largeGroupThreshold: 100,
  });
  return renderJson(toJsonEnvelope('scan-site', SITE, report));
}

/** Mirror of commands/explainAccess.ts orchestration for the web scope. */
async function runExplain(): Promise<string> {
  const sp = client();
  const web = await sp.connect();
  const user = await sp.findUser(JANE);
  assert.ok(user, 'fixture user should resolve');
  const [effectiveMask, userGroupIds, webAssignments] = await Promise.all([
    sp.getUserEffectivePermissions(user!.loginName),
    sp.getUserGroupIds(user!.id),
    sp.getWebRoleAssignments(),
  ]);
  const scopePath: ScopeNode[] = [
    {
      kind: 'web',
      title: web.title || web.url,
      url: web.url,
      hasUniqueRoleAssignments: web.hasUniqueRoleAssignments,
      assignments: webAssignments,
    },
  ];
  const result = buildAccessTrace({
    user: user!,
    effectiveMask,
    userGroupIds,
    path: scopePath,
    isSiteCollectionAdmin: user!.isSiteAdmin,
  });
  return renderJson(toJsonEnvelope('explain-access', SITE, result));
}

/**
 * Mirror of commands/explainAccess.ts orchestration for a `--list` scope that
 * resolves to a DENY: contractor "Rachel Lee" is a site user but is on none of
 * the `Salaries` list ACL entries, so her effective permissions on that list
 * come back empty.
 */
async function runExplainDeny(): Promise<string> {
  const sp = client();
  const web = await sp.connect();
  const user = await sp.findUser(RLEE);
  assert.ok(user, 'fixture user should resolve');
  const [effectiveMask, userGroupIds, webAssignments] = await Promise.all([
    sp.getListUserEffectivePermissions(DENY_LIST, user!.loginName),
    sp.getUserGroupIds(user!.id),
    sp.getWebRoleAssignments(),
  ]);
  const lists = await sp.getLists(true);
  const meta = lists.find((l) => l.title.toLowerCase() === DENY_LIST.toLowerCase());
  const listAssignments = await sp.getListRoleAssignments(DENY_LIST);
  const scopePath: ScopeNode[] = [
    {
      kind: 'web',
      title: web.title || web.url,
      url: web.url,
      hasUniqueRoleAssignments: web.hasUniqueRoleAssignments,
      assignments: webAssignments,
    },
    {
      kind: 'list',
      title: DENY_LIST,
      hasUniqueRoleAssignments: meta?.hasUniqueRoleAssignments ?? true,
      assignments: listAssignments,
    },
  ];
  const result = buildAccessTrace({
    user: user!,
    effectiveMask,
    userGroupIds,
    path: scopePath,
    isSiteCollectionAdmin: user!.isSiteAdmin,
  });
  return renderJson(toJsonEnvelope('explain-access', SITE, result));
}

function normalise(json: string): string {
  const obj = JSON.parse(json) as { generatedAt?: string };
  obj.generatedAt = '1970-01-01T00:00:00.000Z';
  return JSON.stringify(obj, null, 2) + '\n';
}

function checkSample(name: string, produced: string): void {
  const file = path.join(SAMPLE_DIR, name);
  const normalised = name.endsWith('.json') ? normalise(produced) : produced + '\n';
  // Bootstrap on first run (file absent); otherwise assert it is current.
  // Force a rebuild by deleting sample/*.json/*.txt or setting UPDATE_SAMPLES=1.
  if (UPDATE || !fs.existsSync(file)) {
    fs.writeFileSync(file, normalised);
    return;
  }
  const expected = fs.readFileSync(file, 'utf8');
  assert.equal(normalised, expected, `${name} is stale — run UPDATE_SAMPLES=1 npm run test:only`);
}

test('scan-site: synthetic farm produces the expected findings', async () => {
  const out = JSON.parse(await runScan()).result;
  assert.deepEqual(out.summary, {
    listsScanned: 3,
    listsWithUniquePermissions: 1,
    itemsWithUniquePermissions: 1,
    orphanedPrincipals: 1,
    broadGrants: 1,
    largeGroups: 1,
    siteCollectionAdmins: 1,
  });
  assert.deepEqual(out.brokenInheritance.map((b: any) => b.kind).sort(), ['item', 'list', 'web']);
  assert.equal(out.orphanedPrincipals[0].confidence, 'high');
  assert.deepEqual(out.orphanedPrincipals[0].onAcl, ['Salaries']);
  assert.equal(out.broadGrants[0].audience, 'Everyone');
  assert.deepEqual(out.broadGrants[0].roles, ['Read']);
  assert.equal(out.largeGroups[0].title, 'All HR Staff');
  assert.equal(out.largeGroups[0].memberCount, 112);
  assert.equal(out.siteCollectionAdmins[0].title, 'Mark Adams');
});

test('explain-access: synthetic farm explains Jane Doe access', async () => {
  const out = JSON.parse(await runExplain()).result;
  assert.equal(out.hasAccess, true);
  assert.equal(out.fullControl, false);
  assert.deepEqual(out.effectivePermissions, [
    'ViewListItems',
    'OpenItems',
    'Open',
    'ViewPages',
    'BrowseUserInfo',
    'UseRemoteAPIs',
  ]);
  assert.deepEqual(
    out.grantPaths.map((g: any) => g.channel),
    ['sharepoint-group', 'broad-audience', 'ad-group-unresolved'],
  );
  assert.equal(out.grantPaths[0].via, 'HR Members');
  assert.equal(out.unresolvedGroups.length, 1);
  assert.equal(out.unresolvedGroups[0].name, 'CONTOSO\\HR-Admins');
  assert.deepEqual(out.brokenInheritanceAt, [{ kind: 'web', title: 'Human Resources' }]);
  assert.equal(out.user.type, 'User');
});

test('explain-access --list: contractor is denied on the Salaries list', async () => {
  const out = JSON.parse(await runExplainDeny()).result;
  assert.equal(out.hasAccess, false);
  assert.equal(out.fullControl, false);
  assert.deepEqual(out.effectivePermissions, []);
  assert.equal(out.siteCollectionAdmin, false);
  assert.equal(out.user.title, 'Rachel Lee');
  // Governing scope is the list, which breaks inheritance.
  assert.deepEqual(out.brokenInheritanceAt, [
    { kind: 'web', title: 'Human Resources' },
    { kind: 'list', title: 'Salaries' },
  ]);
  // No SharePoint-group or direct grant reaches her on the list ACL.
  assert.ok(!out.grantPaths.some((g: any) => g.channel === 'sharepoint-group' || g.channel === 'direct'));
  // The one AD group on the list ACL is surfaced but the empty mask is authoritative.
  assert.equal(out.unresolvedGroups.length, 1);
  assert.equal(out.unresolvedGroups[0].name, 'CONTOSO\\Payroll');
  assert.ok(out.notes.some((n: string) => n.includes('no access to this scope')));
});

test('committed sample/ worked example is up to date', async () => {
  const scanJson = await runScan();
  const explainJson = await runExplain();
  const explainDenyJson = await runExplainDeny();
  checkSample('scan-site.json', scanJson);
  checkSample('explain-access.json', explainJson);
  checkSample('explain-access-deny.json', explainDenyJson);
  checkSample('scan-site.txt', renderScanReport(JSON.parse(scanJson).result));
  checkSample('explain-access.txt', renderAccessTrace(JSON.parse(explainJson).result, SITE));
  checkSample('explain-access-deny.txt', renderAccessTrace(JSON.parse(explainDenyJson).result, SITE));
});
