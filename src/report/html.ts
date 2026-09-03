/**
 * Standalone HTML rendering of a `scan-site` report. No dependencies, no runtime
 * assets: the returned string is a complete document with inline CSS, RTL-aware,
 * and prints cleanly to PDF from any browser.
 *
 * `scan-site` writes one of these next to its terminal output by default (see
 * `--report` / `--no-report`).
 */

import { JsonEnvelope } from './json';
import { ScanReport } from '../analysis/scanSite';
import { VERSION } from '../version';

function esc(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

const KIND_LABEL: Record<string, string> = { web: 'Web', list: 'List', item: 'Item' };

function tile(label: string, value: number | string, alert: boolean): string {
  const cls = alert && Number(value) > 0 ? 'tile alert' : 'tile';
  return `<div class="${cls}"><div class="tile-value">${esc(value)}</div><div class="tile-label">${esc(label)}</div></div>`;
}

function chips(values: string[], cls = 'chip'): string {
  return values.map((v) => `<span class="${cls}">${esc(v)}</span>`).join(' ');
}

function section(
  title: string,
  count: number,
  headCells: string[],
  bodyRows: string,
  emptyMsg: string,
): string {
  const body =
    count === 0
      ? `<p class="empty">${esc(emptyMsg)}</p>`
      : `<div class="table-wrap"><table>
          <thead><tr>${headCells.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table></div>`;
  return `<section><h2>${esc(title)} <span class="count">${count}</span></h2>${body}</section>`;
}

export function renderScanHtml(envelope: JsonEnvelope<ScanReport>): string {
  const r = envelope.result;
  const s = r.summary;
  const generated = new Date(envelope.generatedAt);

  const tiles = [
    tile('Webs scanned', r.websScanned ?? 1, false),
    tile('Lists scanned', s.listsScanned, false),
    tile('Lists w/ unique perms', s.listsWithUniquePermissions, false),
    tile('Items w/ unique perms', s.itemsWithUniquePermissions, false),
    tile('Orphaned principals', s.orphanedPrincipals, true),
    tile('Broad-audience grants', s.broadGrants, true),
    tile('Oversized groups', s.largeGroups, true),
    tile('Site collection admins', s.siteCollectionAdmins, false),
  ].join('');

  const biRows = r.brokenInheritance
    .map((b) => {
      const link = b.url ? ` <a href="${esc(b.url)}">${esc(b.url)}</a>` : '';
      return `<tr>
        <td><span class="badge badge-${esc(b.kind)}">${esc(KIND_LABEL[b.kind] ?? b.kind)}</span></td>
        <td>${esc(b.web ?? '')}</td>
        <td class="name">${esc(b.title)}${link}</td>
        <td class="num">${esc(b.assignmentCount)}</td>
        <td>${chips(b.principals)}</td>
      </tr>`;
    })
    .join('');

  const bgRows = r.broadGrants
    .map(
      (g) => `<tr>
        <td>${esc(g.web ?? '')}</td>
        <td class="name">${esc(g.scope)}</td>
        <td>${chips([g.audience], 'chip chip-warn')}</td>
        <td>${chips(g.roles)}</td>
      </tr>`,
    )
    .join('');

  const opRows = r.orphanedPrincipals
    .map(
      (o) => `<tr>
        <td>${esc(o.web ?? '')}</td>
        <td class="name">${esc(o.title || o.loginName)}</td>
        <td class="mono">${esc(o.loginName)}</td>
        <td>${esc(o.confidence)}</td>
        <td>${esc(o.reason)}</td>
      </tr>`,
    )
    .join('');

  const lgRows = r.largeGroups
    .map(
      (g) => `<tr>
        <td class="name">${esc(g.title)}</td>
        <td>${esc(g.web ?? '')}</td>
        <td class="num">${esc(g.memberCount)}</td>
        <td>${esc(g.owner)}</td>
      </tr>`,
    )
    .join('');

  const scaRows = r.siteCollectionAdmins
    .map((a) => `<tr><td class="name">${esc(a.title)}</td><td class="mono">${esc(a.loginName)}</td></tr>`)
    .join('');

  const stamp = generated.toISOString().replace('T', ' ').replace(/\..+/, ' UTC');

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SharePoint permission scan — ${esc(r.site.title || envelope.site)}</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #fff; --ink: #1a1c1f; --muted: #666; --line: #e3e5e8;
    --warn-bg: #fff4e5; --warn-ink: #8a5200; --alert: #c23b3b; --chip-bg: #eef1f4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181c; --card: #1e2126; --ink: #e6e8ea; --muted: #9aa0a6; --line: #2c2f36;
      --warn-bg: #3a2e1a; --warn-ink: #ffcf8a; --alert: #ff6b6b; --chip-bg: #2a2e35;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: var(--bg); color: var(--ink);
    font: 14px/1.6 "Segoe UI", Tahoma, system-ui, sans-serif; }
  .report { max-width: 1100px; margin: 0 auto; }
  header { margin-bottom: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; }
  .sub a { color: inherit; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px; margin: 20px 0 8px; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .tile.alert { border-color: var(--alert); }
  .tile-value { font-size: 24px; font-weight: 700; }
  .tile.alert .tile-value { color: var(--alert); }
  .tile-label { color: var(--muted); font-size: 12px; margin-top: 2px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 4px 20px 16px; margin-top: 20px; }
  h2 { font-size: 15px; margin: 16px 0 12px; display: flex; align-items: center; gap: 8px; }
  .count { background: var(--chip-bg); color: var(--muted); border-radius: 999px;
    padding: 1px 9px; font-size: 12px; font-weight: 600; }
  .empty { color: var(--muted); font-style: italic; margin: 4px 0 8px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; white-space: nowrap; }
  td.num, td.name { white-space: nowrap; }
  td.num { font-variant-numeric: tabular-nums; }
  .mono, .name a { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }
  .badge { border-radius: 6px; padding: 1px 8px; font-size: 11px; font-weight: 700; }
  .badge-web { background: #e5efff; color: #1c4fb0; }
  .badge-list { background: #e9f7e9; color: #1f7a34; }
  .badge-item { background: #f3e9ff; color: #6b30b0; }
  @media (prefers-color-scheme: dark) {
    .badge-web { background: #1c3a66; color: #cfe0ff; }
    .badge-list { background: #1e4a2b; color: #cdefd4; }
    .badge-item { background: #3d2860; color: #e6d4ff; }
  }
  .chip { display: inline-block; background: var(--chip-bg); border-radius: 6px;
    padding: 1px 7px; margin: 1px 0; font-size: 12px; white-space: nowrap; }
  .chip-warn { background: var(--warn-bg); color: var(--warn-ink); font-weight: 600; }
  footer { color: var(--muted); font-size: 12px; margin-top: 24px; text-align: center; }
  @media print {
    body { padding: 0; background: #fff; }
    section, .tile { border-color: #ccc; break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="report">
  <header>
    <h1>SharePoint permission scan</h1>
    <div class="sub">
      ${esc(r.site.title)} &nbsp;·&nbsp; <a href="${esc(r.site.url || envelope.site)}">${esc(r.site.url || envelope.site)}</a><br>
      ${esc(r.websScanned ?? 1)} web(s) scanned &nbsp;·&nbsp; generated ${esc(stamp)}
      &nbsp;·&nbsp; sppa v${esc(VERSION)} &nbsp;·&nbsp; schema v${esc(envelope.schemaVersion)}
    </div>
  </header>

  <div class="grid">${tiles}</div>

  ${section('Broken inheritance', r.brokenInheritance.length, ['Kind', 'Web', 'Scope', 'Assignments', 'Principals'], biRows, 'No scopes break inheritance.')}
  ${section('Broad-audience grants', r.broadGrants.length, ['Web', 'Scope', 'Audience', 'Roles'], bgRows, 'No "Everyone" / broad-audience grants.')}
  ${section('Orphaned principals', r.orphanedPrincipals.length, ['Web', 'Principal', 'Login / SID', 'Confidence', 'Reason'], opRows, 'No orphaned SIDs on any ACL.')}
  ${section('Oversized SharePoint groups', r.largeGroups.length, ['Group', 'Web', 'Members', 'Owner'], lgRows, 'No group exceeds the size threshold.')}
  ${section('Site collection administrators', r.siteCollectionAdmins.length, ['Name', 'Login'], scaRows, 'None reported.')}

  <footer>Generated by sppa · read-only audit · no data left the machine it ran on</footer>
</div>
</body>
</html>
`;
}
