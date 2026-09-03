/**
 * Pure logic: the inverse of accessTrace — given the role assignments on a
 * scope and the SharePoint groups on the farm, enumerate *who* has access to
 * that scope and how. SharePoint groups are expanded to their members; AD
 * security groups and broad-audience claims cannot be expanded via REST and are
 * reported as single unexpandable entries. No I/O; unit-tested.
 */

import {
  broadAudienceLabel,
  Principal,
  PrincipalType,
  RoleAssignment,
} from '../sp/principals';

export type AccessEntryKind = 'user' | 'sharepoint-group' | 'ad-group' | 'broad-audience';

export interface AccessEntry {
  kind: AccessEntryKind;
  name: string;
  login: string;
  email?: string;
  roles: string[];
  /** For a user surfaced through one or more SharePoint groups: those group names. */
  via?: string;
  /** False for AD security groups and broad-audience claims (membership unknown). */
  expandable: boolean;
}

export interface ListAccessInput {
  scope: { kind: 'web' | 'list'; title: string; url?: string };
  /** True when a `--list` scope inherits from the web (ACL lives on the parent). */
  inheritedFromParent: boolean;
  /** Where the governing role assignments actually live (web title or list title). */
  governingScopeTitle: string;
  assignments: RoleAssignment[];
  /** SharePoint group id -> its direct members. */
  groupMembers: Map<number, Principal[]>;
  /** login (lower-case) -> email, to enrich expanded members. */
  emailByLogin: Map<string, string>;
  siteCollectionAdmins: Array<{ loginName: string; title: string }>;
}

export interface ListAccessResult {
  scope: { kind: 'web' | 'list'; title: string; url?: string };
  governingScopeTitle: string;
  inheritedFromParent: boolean;
  /** Distinct users plus each unexpandable (AD group / broad audience) entry. */
  principalCount: number;
  entries: AccessEntry[];
  siteCollectionAdmins: Array<{ loginName: string; title: string }>;
  notes: string[];
}

function meaningfulRoles(roles: string[]): string[] {
  const filtered = roles.filter((r) => r !== 'Limited Access');
  return filtered.length ? filtered : roles;
}

function mergeRoles(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

export function analyzeListAccess(input: ListAccessInput): ListAccessResult {
  const groupEntries: AccessEntry[] = [];
  const unexpandable: AccessEntry[] = [];
  /** login (lower-case) -> merged user entry. */
  const users = new Map<string, AccessEntry>();
  const viaByLogin = new Map<string, Set<string>>();

  const addUser = (p: { loginName: string; title: string; email?: string }, roles: string[], via?: string): void => {
    const key = p.loginName.toLowerCase();
    const email = p.email || input.emailByLogin.get(key) || undefined;
    const existing = users.get(key);
    if (existing) {
      existing.roles = mergeRoles(existing.roles, roles);
    } else {
      users.set(key, {
        kind: 'user',
        name: p.title || p.loginName,
        login: p.loginName,
        ...(email === undefined ? {} : { email }),
        roles: [...roles],
        expandable: true,
      });
    }
    if (via) {
      const set = viaByLogin.get(key) ?? new Set<string>();
      set.add(via);
      viaByLogin.set(key, set);
    }
  };

  let adGroupCount = 0;
  for (const ra of input.assignments) {
    const roles = meaningfulRoles(ra.roles);
    const audience = broadAudienceLabel(ra.principalLoginName);

    if (audience) {
      unexpandable.push({
        kind: 'broad-audience',
        name: audience,
        login: ra.principalLoginName,
        roles,
        expandable: false,
      });
      continue;
    }

    if (ra.principalType === PrincipalType.User) {
      addUser({ loginName: ra.principalLoginName, title: ra.principalTitle }, roles);
      continue;
    }

    if (ra.principalType === PrincipalType.SharePointGroup) {
      const members = input.groupMembers.get(ra.principalId) ?? [];
      groupEntries.push({
        kind: 'sharepoint-group',
        name: ra.principalTitle || `group #${ra.principalId}`,
        login: ra.principalLoginName,
        roles,
        expandable: true,
      });
      for (const m of members) {
        addUser({ loginName: m.loginName, title: m.title, email: m.email }, roles, ra.principalTitle || `group #${ra.principalId}`);
      }
      continue;
    }

    // AD security group or distribution list — REST cannot expand membership.
    adGroupCount++;
    unexpandable.push({
      kind: 'ad-group',
      name: ra.principalTitle || ra.principalLoginName,
      login: ra.principalLoginName,
      roles,
      expandable: false,
    });
  }

  for (const [key, entry] of users) {
    const via = viaByLogin.get(key);
    if (via && via.size) entry.via = [...via].sort().join(', ');
  }

  const userEntries = [...users.values()].sort((a, b) => a.name.localeCompare(b.name));
  groupEntries.sort((a, b) => a.name.localeCompare(b.name));
  unexpandable.sort((a, b) => a.name.localeCompare(b.name));

  const notes: string[] = [];
  if (input.inheritedFromParent) {
    notes.push(
      `This ${input.scope.kind} inherits permissions from "${input.governingScopeTitle}" — the access below is the parent scope's.`,
    );
  }
  if (adGroupCount > 0) {
    notes.push(
      `${adGroupCount} AD security group(s) grant access here. REST cannot expand their membership, so their members are not listed individually.`,
    );
  }
  if (input.siteCollectionAdmins.length > 0) {
    notes.push(
      'Site collection administrators have Full Control everywhere regardless of the assignments above.',
    );
  }

  const principalCount = userEntries.length + unexpandable.length;

  return {
    scope: input.scope,
    governingScopeTitle: input.governingScopeTitle,
    inheritedFromParent: input.inheritedFromParent,
    principalCount,
    entries: [...groupEntries, ...unexpandable, ...userEntries],
    siteCollectionAdmins: input.siteCollectionAdmins,
    notes,
  };
}
