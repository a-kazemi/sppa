/**
 * Pure logic: turn a single site collection's fetched permission data into an
 * audit report — broken inheritance, orphaned SIDs, broad grants, oversized
 * groups, and site-collection admins. No I/O; unit-tested against fixtures.
 */

import {
  broadAudienceLabel,
  classifyOrphan,
  OrphanConfidence,
  Principal,
  RoleAssignment,
} from '../sp/principals';

export interface ScanScope {
  kind: 'web' | 'list' | 'item';
  title: string;
  url?: string;
  baseTemplate?: number;
  itemCount?: number;
  assignments: RoleAssignment[];
}

export interface ScanInput {
  web: { title: string; url: string; hasUniqueRoleAssignments: boolean; assignments: RoleAssignment[] };
  lists: Array<{
    id: string;
    title: string;
    hasUniqueRoleAssignments: boolean;
    baseTemplate: number;
    itemCount: number;
    assignments: RoleAssignment[];
    uniqueItems: Array<{ id: number; fileRef: string; assignments: RoleAssignment[] }>;
  }>;
  siteUsers: Principal[];
  siteGroups: Array<{ id: number; title: string; ownerTitle: string; users: Principal[] }>;
  largeGroupThreshold: number;
  /**
   * Server-relative URL of the web these findings belong to. When set, every
   * finding is stamped with it so a recursive (`--recurse`) report can say which
   * subweb each row came from. Omitted for a single-web scan.
   */
  webUrl?: string;
}

export interface BrokenInheritanceFinding {
  kind: 'web' | 'list' | 'item';
  title: string;
  url?: string;
  assignmentCount: number;
  principals: string[];
  web?: string;
}

export interface OrphanReportItem {
  id: number;
  loginName: string;
  title: string;
  confidence: OrphanConfidence;
  reason: string;
  onAcl: string[];
  web?: string;
}

export interface BroadGrantFinding {
  scope: string;
  audience: string;
  roles: string[];
  web?: string;
}

export interface LargeGroupFinding {
  title: string;
  memberCount: number;
  owner: string;
  web?: string;
}

export interface ScanReport {
  site: { title: string; url: string };
  summary: {
    listsScanned: number;
    listsWithUniquePermissions: number;
    itemsWithUniquePermissions: number;
    orphanedPrincipals: number;
    broadGrants: number;
    largeGroups: number;
    siteCollectionAdmins: number;
  };
  brokenInheritance: BrokenInheritanceFinding[];
  orphanedPrincipals: OrphanReportItem[];
  broadGrants: BroadGrantFinding[];
  largeGroups: LargeGroupFinding[];
  siteCollectionAdmins: Array<{ loginName: string; title: string }>;
  /** Number of webs walked. Present only for a recursive scan. */
  websScanned?: number;
}

function principalLabel(ra: RoleAssignment): string {
  return ra.principalTitle || ra.principalLoginName || `#${ra.principalId}`;
}

function meaningfulRoles(roles: string[]): string[] {
  const filtered = roles.filter((r) => r !== 'Limited Access');
  return filtered.length ? filtered : roles;
}

export function analyzeScan(input: ScanInput): ScanReport {
  const brokenInheritance: BrokenInheritanceFinding[] = [];
  const broadGrants: BroadGrantFinding[] = [];

  const collectBroad = (scopeName: string, assignments: RoleAssignment[]): void => {
    for (const ra of assignments) {
      const audience = broadAudienceLabel(ra.principalLoginName);
      if (audience) {
        broadGrants.push({ scope: scopeName, audience, roles: meaningfulRoles(ra.roles) });
      }
    }
  };

  if (input.web.hasUniqueRoleAssignments) {
    brokenInheritance.push({
      kind: 'web',
      title: input.web.title || input.web.url,
      url: input.web.url,
      assignmentCount: input.web.assignments.length,
      principals: input.web.assignments.map(principalLabel),
    });
  }
  collectBroad(input.web.title || 'Site', input.web.assignments);

  let itemsWithUnique = 0;
  for (const list of input.lists) {
    if (list.hasUniqueRoleAssignments) {
      brokenInheritance.push({
        kind: 'list',
        title: list.title,
        assignmentCount: list.assignments.length,
        principals: list.assignments.map(principalLabel),
      });
      collectBroad(list.title, list.assignments);
    }
    for (const item of list.uniqueItems) {
      itemsWithUnique++;
      brokenInheritance.push({
        kind: 'item',
        title: item.fileRef || `${list.title} item #${item.id}`,
        assignmentCount: item.assignments.length,
        principals: item.assignments.map(principalLabel),
      });
      collectBroad(item.fileRef || `${list.title} #${item.id}`, item.assignments);
    }
  }

  // Where each orphan sits on an ACL (best-effort, by id/login match).
  const aclIndex = new Map<string, string[]>();
  const indexAssignments = (scopeName: string, assignments: RoleAssignment[]): void => {
    for (const ra of assignments) {
      for (const key of [String(ra.principalId), ra.principalLoginName.toLowerCase()]) {
        if (!key) continue;
        const arr = aclIndex.get(key) ?? [];
        arr.push(scopeName);
        aclIndex.set(key, arr);
      }
    }
  };
  indexAssignments(input.web.title || 'Site', input.web.assignments);
  for (const list of input.lists) {
    if (list.hasUniqueRoleAssignments) indexAssignments(list.title, list.assignments);
    for (const item of list.uniqueItems) indexAssignments(item.fileRef || `${list.title} #${item.id}`, item.assignments);
  }

  const orphanedPrincipals: OrphanReportItem[] = [];
  for (const p of input.siteUsers) {
    const finding = classifyOrphan(p);
    if (!finding) continue;
    const onAcl =
      aclIndex.get(String(p.id)) ?? aclIndex.get(p.loginName.toLowerCase()) ?? [];
    orphanedPrincipals.push({
      id: p.id,
      loginName: p.loginName,
      title: p.title,
      confidence: finding.confidence,
      reason: finding.reason,
      onAcl: Array.from(new Set(onAcl)),
    });
  }

  const largeGroups: LargeGroupFinding[] = input.siteGroups
    .filter((g) => g.users.length >= input.largeGroupThreshold)
    .map((g) => ({ title: g.title, memberCount: g.users.length, owner: g.ownerTitle }))
    .sort((a, b) => b.memberCount - a.memberCount);

  const siteCollectionAdmins = input.siteUsers
    .filter((p) => p.isSiteAdmin)
    .map((p) => ({ loginName: p.loginName, title: p.title }));

  if (input.webUrl) {
    for (const f of brokenInheritance) f.web = input.webUrl;
    for (const f of orphanedPrincipals) f.web = input.webUrl;
    for (const f of broadGrants) f.web = input.webUrl;
    for (const f of largeGroups) f.web = input.webUrl;
  }

  return {
    site: { title: input.web.title, url: input.web.url },
    summary: {
      listsScanned: input.lists.length,
      listsWithUniquePermissions: input.lists.filter((l) => l.hasUniqueRoleAssignments).length,
      itemsWithUniquePermissions: itemsWithUnique,
      orphanedPrincipals: orphanedPrincipals.length,
      broadGrants: broadGrants.length,
      largeGroups: largeGroups.length,
      siteCollectionAdmins: siteCollectionAdmins.length,
    },
    brokenInheritance,
    orphanedPrincipals,
    broadGrants,
    largeGroups,
    siteCollectionAdmins,
  };
}

/**
 * Combine per-web reports from a recursive scan into one. Findings are
 * concatenated (each already stamped with its `web`), summary counts are summed,
 * and site-collection administrators — which are farm-wide, not per-web — are
 * de-duplicated by login. `site` is taken from the first (root) report.
 */
export function mergeScanReports(reports: ScanReport[]): ScanReport {
  const first = reports[0];
  if (!first) throw new Error('mergeScanReports: no reports to merge');
  if (reports.length === 1) return { ...first, websScanned: 1 };

  const brokenInheritance = reports.flatMap((r) => r.brokenInheritance);
  const orphanedPrincipals = reports.flatMap((r) => r.orphanedPrincipals);
  const broadGrants = reports.flatMap((r) => r.broadGrants);
  const largeGroups = reports.flatMap((r) => r.largeGroups);

  const adminsByLogin = new Map<string, { loginName: string; title: string }>();
  for (const r of reports) {
    for (const a of r.siteCollectionAdmins) adminsByLogin.set(a.loginName.toLowerCase(), a);
  }
  const siteCollectionAdmins = [...adminsByLogin.values()];

  return {
    site: first.site,
    summary: {
      listsScanned: sum(reports, (r) => r.summary.listsScanned),
      listsWithUniquePermissions: sum(reports, (r) => r.summary.listsWithUniquePermissions),
      itemsWithUniquePermissions: sum(reports, (r) => r.summary.itemsWithUniquePermissions),
      orphanedPrincipals: orphanedPrincipals.length,
      broadGrants: broadGrants.length,
      largeGroups: largeGroups.length,
      siteCollectionAdmins: siteCollectionAdmins.length,
    },
    brokenInheritance,
    orphanedPrincipals,
    broadGrants,
    largeGroups,
    siteCollectionAdmins,
    websScanned: reports.length,
  };
}

function sum<T>(items: T[], pick: (t: T) => number): number {
  return items.reduce((acc, t) => acc + pick(t), 0);
}
