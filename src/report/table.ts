/** Human-readable text rendering for the terminal. */

import { AccessTraceResult, GrantPath } from '../analysis/accessTrace';
import { ScanReport } from '../analysis/scanSite';
import { AccessEntry, ListAccessResult } from '../analysis/listAccess';
import { color, heading } from '../util/ansi';
import { PERMISSION_LABELS } from '../sp/permissions';

const bullet = color.dim('  •');

function permLabel(name: string): string {
  if (name === 'FullControl') return 'Full Control';
  return PERMISSION_LABELS[name] ?? name;
}

function channelPhrase(g: GrantPath): string {
  switch (g.channel) {
    case 'direct':
      return 'Direct permission assignment';
    case 'sharepoint-group':
      return `SharePoint group "${g.via}"`;
    case 'broad-audience':
      return `Broad audience: ${g.via}`;
    case 'ad-group-unresolved':
      return `AD security group "${g.via}" (membership not verifiable via REST)`;
  }
}

export function renderAccessTrace(r: AccessTraceResult, site: string): string {
  const out: string[] = [];
  out.push(heading('SharePoint access explanation'));
  out.push(`${color.dim('Site:')} ${site}`);
  out.push(
    `${color.dim('User:')} ${r.user.title || r.user.loginName} ${color.dim(`(${r.user.type}, id ${r.user.id})`)}`,
  );
  out.push(`${color.dim('Login:')} ${r.user.loginName}`);
  out.push('');

  const verdict = r.hasAccess
    ? color.green(r.fullControl ? 'HAS ACCESS — Full Control' : 'HAS ACCESS')
    : color.red('NO ACCESS');
  out.push(`${color.bold('Verdict:')} ${verdict}`);

  if (r.effectivePermissions.length) {
    out.push('');
    out.push(color.bold('Effective permissions on this scope:'));
    for (const p of r.effectivePermissions) out.push(`${bullet} ${permLabel(p)}`);
  }

  if (r.brokenInheritanceAt.length) {
    out.push('');
    out.push(color.bold('Inheritance is broken at:'));
    for (const b of r.brokenInheritanceAt) out.push(`${bullet} ${b.kind}: ${b.title}`);
  } else {
    out.push('');
    out.push(color.dim('Permissions are inherited from the site root (no unique assignments on the path).'));
  }

  out.push('');
  out.push(color.bold('How access is granted:'));
  if (r.grantPaths.length === 0) {
    out.push(color.dim('  (no explicit grant matched on the governing scope)'));
  }
  for (const g of r.grantPaths) {
    const roles = g.roles.length ? g.roles.join(', ') : '(no role bindings)';
    const mark = g.certain ? color.green('✓') : color.yellow('?');
    out.push(`  ${mark} ${channelPhrase(g)} — ${color.cyan(roles)} ${color.dim(`@ ${g.scopeKind} "${g.scopeTitle}"`)}`);
    if (g.note) out.push(`      ${color.dim(g.note)}`);
  }

  if (r.unresolvedGroups.length) {
    out.push('');
    out.push(color.bold('AD security groups on the ACL (not expanded):'));
    for (const u of r.unresolvedGroups) {
      out.push(`${bullet} ${u.name} — ${u.roles.join(', ') || '(no roles)'} ${color.dim(`@ ${u.scopeTitle}`)}`);
    }
  }

  if (r.notes.length) {
    out.push('');
    out.push(color.bold('Notes:'));
    for (const n of r.notes) out.push(`${bullet} ${n}`);
  }

  return out.join('\n');
}

export function renderScanReport(r: ScanReport): string {
  const out: string[] = [];
  out.push(heading('SharePoint permission scan'));
  out.push(`${color.dim('Site:')} ${r.site.title || r.site.url}  ${color.dim(r.site.url)}`);
  out.push('');

  const s = r.summary;
  out.push(color.bold('Summary'));
  if (r.websScanned !== undefined) out.push(`${bullet} Webs scanned: ${r.websScanned}`);
  out.push(`${bullet} Lists scanned: ${s.listsScanned}`);
  out.push(`${bullet} Lists with unique permissions: ${flag(s.listsWithUniquePermissions)}`);
  out.push(`${bullet} Items with unique permissions: ${flag(s.itemsWithUniquePermissions)}`);
  out.push(`${bullet} Orphaned principals: ${flag(s.orphanedPrincipals)}`);
  out.push(`${bullet} Broad-audience grants: ${flag(s.broadGrants)}`);
  out.push(`${bullet} Oversized groups: ${flag(s.largeGroups)}`);
  out.push(`${bullet} Site collection administrators: ${s.siteCollectionAdmins}`);

  if (r.brokenInheritance.length) {
    out.push('');
    out.push(color.bold(`Broken inheritance (${r.brokenInheritance.length})`));
    for (const b of r.brokenInheritance.slice(0, 200)) {
      out.push(
        `${bullet} ${color.yellow(b.kind)} ${b.title}${webSuffix(b.web)} ${color.dim(`— ${b.assignmentCount} assignment(s): ${b.principals.slice(0, 6).join(', ')}${b.principals.length > 6 ? '…' : ''}`)}`,
      );
    }
    if (r.brokenInheritance.length > 200) out.push(color.dim(`  …and ${r.brokenInheritance.length - 200} more`));
  }

  if (r.orphanedPrincipals.length) {
    out.push('');
    out.push(color.bold(`Orphaned principals (${r.orphanedPrincipals.length})`));
    for (const o of r.orphanedPrincipals) {
      const conf = o.confidence === 'high' ? color.red('high') : color.yellow('medium');
      out.push(`${bullet} [${conf}] ${o.title || o.loginName}${webSuffix(o.web)} ${color.dim(`— ${o.reason}`)}`);
      if (o.onAcl.length) out.push(`      ${color.dim(`on ACL: ${o.onAcl.join(', ')}`)}`);
    }
  }

  if (r.broadGrants.length) {
    out.push('');
    out.push(color.bold(`Broad-audience grants (${r.broadGrants.length})`));
    for (const g of r.broadGrants) {
      out.push(`${bullet} ${color.red(g.audience)} @ ${g.scope}${webSuffix(g.web)} ${color.dim(`— ${g.roles.join(', ') || '(no roles)'}`)}`);
    }
  }

  if (r.largeGroups.length) {
    out.push('');
    out.push(color.bold(`Oversized groups (${r.largeGroups.length})`));
    for (const g of r.largeGroups) {
      out.push(`${bullet} ${g.title}${webSuffix(g.web)} — ${g.memberCount} members ${color.dim(g.owner ? `(owner: ${g.owner})` : '')}`);
    }
  }

  if (r.siteCollectionAdmins.length) {
    out.push('');
    out.push(color.bold(`Site collection administrators (${r.siteCollectionAdmins.length})`));
    for (const a of r.siteCollectionAdmins) {
      out.push(`${bullet} ${a.title || a.loginName} ${color.dim(a.loginName)}`);
    }
  }

  out.push('');
  out.push(color.dim('Read-only scan. No data left this machine.'));
  return out.join('\n');
}

function flag(n: number): string {
  return n > 0 ? color.yellow(String(n)) : color.green('0');
}

function webSuffix(web: string | undefined): string {
  return web ? color.dim(` @${web}`) : '';
}

const KIND_LABEL: Record<AccessEntry['kind'], string> = {
  user: 'user',
  'sharepoint-group': 'SharePoint group',
  'ad-group': 'AD security group',
  'broad-audience': 'broad audience',
};

export function renderListAccess(r: ListAccessResult, site: string): string {
  const out: string[] = [];
  out.push(heading('Who has access'));
  out.push(`${color.dim('Site:')} ${site}`);
  out.push(`${color.dim('Scope:')} ${r.scope.kind} "${r.scope.title}"`);
  if (r.inheritedFromParent) {
    out.push(`${color.dim('ACL from:')} ${r.governingScopeTitle} (inherited)`);
  }
  out.push('');
  out.push(`${color.bold('Principals with access:')} ${r.principalCount}`);

  const groups = r.entries.filter((e) => e.kind === 'sharepoint-group');
  const unexpandable = r.entries.filter((e) => e.kind === 'ad-group' || e.kind === 'broad-audience');
  const users = r.entries.filter((e) => e.kind === 'user');

  if (groups.length) {
    out.push('');
    out.push(color.bold(`SharePoint groups (${groups.length})`));
    for (const g of groups) {
      out.push(`${bullet} ${g.name} — ${color.cyan(g.roles.join(', ') || '(no roles)')}`);
    }
  }

  if (unexpandable.length) {
    out.push('');
    out.push(color.bold(`Not expandable via REST (${unexpandable.length})`));
    for (const e of unexpandable) {
      const tag = e.kind === 'broad-audience' ? color.red(KIND_LABEL[e.kind]) : color.yellow(KIND_LABEL[e.kind]);
      out.push(`${bullet} [${tag}] ${e.name} — ${color.cyan(e.roles.join(', ') || '(no roles)')}`);
    }
  }

  if (users.length) {
    out.push('');
    out.push(color.bold(`Users (${users.length})`));
    for (const u of users) {
      const via = u.via ? color.dim(` via ${u.via}`) : color.dim(' (direct)');
      const mail = u.email ? color.dim(` <${u.email}>`) : '';
      out.push(`${bullet} ${u.name}${mail} — ${color.cyan(u.roles.join(', ') || '(no roles)')}${via}`);
    }
  }

  if (r.siteCollectionAdmins.length) {
    out.push('');
    out.push(color.bold(`Site collection administrators (${r.siteCollectionAdmins.length})`));
    for (const a of r.siteCollectionAdmins) {
      out.push(`${bullet} ${a.title || a.loginName} ${color.dim(a.loginName)}`);
    }
  }

  if (r.notes.length) {
    out.push('');
    out.push(color.bold('Notes:'));
    for (const n of r.notes) out.push(`${bullet} ${n}`);
  }

  out.push('');
  out.push(color.dim('Read-only. No data left this machine.'));
  return out.join('\n');
}
