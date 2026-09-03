/**
 * The standalone HTML report (`scan-site` writes it by default; scripts/scan-report.mjs
 * re-renders a saved envelope). Checks the document is well-formed enough to open,
 * carries every section, and HTML-escapes untrusted strings from the farm.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderScanHtml } from '../src/report/html';
import { toJsonEnvelope } from '../src/report/json';
import { ScanReport } from '../src/analysis/scanSite';

function report(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    site: { title: 'HR & Payroll', url: 'https://sp/sites/hr' },
    summary: {
      listsScanned: 3,
      listsWithUniquePermissions: 1,
      itemsWithUniquePermissions: 0,
      orphanedPrincipals: 1,
      broadGrants: 1,
      largeGroups: 0,
      siteCollectionAdmins: 1,
    },
    brokenInheritance: [
      { kind: 'list', title: '<Salaries>', assignmentCount: 2, principals: ['Bob', 'Everyone'], web: '/sites/hr' },
    ],
    orphanedPrincipals: [
      { id: 9, loginName: 'i:0#.w|contoso\\S-1-5-21-x', title: 'S-1-5-21-x', confidence: 'high', reason: 'unresolved SID', onAcl: ['HR Members'] },
    ],
    broadGrants: [{ scope: 'HR', audience: 'Everyone', roles: ['Read'], web: '/sites/hr' }],
    largeGroups: [],
    siteCollectionAdmins: [{ loginName: 'i:0#.w|contoso\\admin', title: 'Admin' }],
    ...overrides,
  };
}

test('renders a complete, self-contained HTML document', () => {
  const html = renderScanHtml(toJsonEnvelope('scan-site', 'https://sp/sites/hr', report()));
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/);
  assert.ok(!html.includes('<script'), 'no scripts');
  assert.ok(html.includes('<style'), 'inline CSS present');
  for (const heading of [
    'Broken inheritance',
    'Broad-audience grants',
    'Orphaned principals',
    'Oversized SharePoint groups',
    'Site collection administrators',
  ]) {
    assert.ok(html.includes(heading), `section "${heading}" present`);
  }
});

test('escapes untrusted strings from the farm', () => {
  const html = renderScanHtml(toJsonEnvelope('scan-site', 'https://sp/sites/hr', report()));
  assert.ok(html.includes('&lt;Salaries&gt;'), 'list title is escaped');
  assert.ok(!html.includes('<Salaries>'), 'raw angle brackets do not reach the DOM');
  assert.ok(html.includes('HR &amp; Payroll'), 'ampersand in the site title is escaped');
});

test('empty finding lists render an explicit "none" note, not an empty table', () => {
  const html = renderScanHtml(
    toJsonEnvelope('scan-site', 'https://sp/sites/hr', report({ largeGroups: [], brokenInheritance: [] })),
  );
  assert.ok(html.includes('No group exceeds the size threshold.'));
  assert.ok(html.includes('No scopes break inheritance.'));
});
