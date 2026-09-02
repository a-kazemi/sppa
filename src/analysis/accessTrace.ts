/**
 * Pure logic: given data already fetched from SharePoint, explain *why* a user
 * does or does not have access to a scope, and where inheritance is broken along
 * the path. No I/O here so it can be unit-tested against recorded fixtures.
 */

import {
  broadAudienceLabel,
  Principal,
  principalTypeName,
  PrincipalType,
  RoleAssignment,
} from '../sp/principals';
import { canAccess, grantedKinds, isFullControl, PermMask } from '../sp/permissions';

export interface ScopeNode {
  kind: 'web' | 'list' | 'item';
  title: string;
  url?: string;
  hasUniqueRoleAssignments: boolean;
  assignments: RoleAssignment[];
}

export interface AccessTraceInput {
  user: Principal;
  /** Effective permission mask at the deepest requested scope. */
  effectiveMask: PermMask;
  /** SharePoint group ids the user is a direct member of. */
  userGroupIds: number[];
  /** Path from the web root down to the requested scope (inclusive), in order. */
  path: ScopeNode[];
  /** Whether the user is a site collection administrator. */
  isSiteCollectionAdmin: boolean;
}

export type GrantChannel = 'direct' | 'sharepoint-group' | 'broad-audience' | 'ad-group-unresolved';

export interface GrantPath {
  channel: GrantChannel;
  scopeTitle: string;
  scopeKind: ScopeNode['kind'];
  /** SharePoint group / AD group / audience name (empty for direct). */
  via: string;
  roles: string[];
  /** True when the grant definitely applies; false when it can only be inferred. */
  certain: boolean;
  note?: string;
}

export interface AccessTraceResult {
  user: {
    id: number;
    loginName: string;
    title: string;
    type: string;
  };
  hasAccess: boolean;
  fullControl: boolean;
  effectivePermissions: string[];
  siteCollectionAdmin: boolean;
  brokenInheritanceAt: Array<{ kind: ScopeNode['kind']; title: string }>;
  grantPaths: GrantPath[];
  /** AD security groups on the ACL whose membership REST cannot expand. */
  unresolvedGroups: Array<{ name: string; scopeTitle: string; roles: string[] }>;
  notes: string[];
}

export function buildAccessTrace(input: AccessTraceInput): AccessTraceResult {
  const { user, effectiveMask, userGroupIds, path, isSiteCollectionAdmin } = input;
  const groupIdSet = new Set(userGroupIds);

  const brokenInheritanceAt = path
    .filter((n) => n.hasUniqueRoleAssignments)
    .map((n) => ({ kind: n.kind, title: n.title }));

  const grantPaths: GrantPath[] = [];
  const unresolvedGroups: AccessTraceResult['unresolvedGroups'] = [];
  const notes: string[] = [];

  // The scope that actually governs access is the deepest node with unique
  // permissions; if none break inheritance, it is the web.
  const governingIndex = lastIndexOf(path, (n) => n.hasUniqueRoleAssignments);
  const governing = governingIndex >= 0 ? path[governingIndex]! : path[0];

  if (governing) {
    for (const ra of governing.assignments) {
      const roles = ra.roles.filter((r) => r !== 'Limited Access');
      const effectiveRoles = roles.length ? roles : ra.roles;

      if (ra.principalId === user.id && ra.principalType === PrincipalType.User) {
        grantPaths.push({
          channel: 'direct',
          scopeTitle: governing.title,
          scopeKind: governing.kind,
          via: '',
          roles: effectiveRoles,
          certain: true,
        });
        continue;
      }

      if (ra.principalType === PrincipalType.SharePointGroup && groupIdSet.has(ra.principalId)) {
        grantPaths.push({
          channel: 'sharepoint-group',
          scopeTitle: governing.title,
          scopeKind: governing.kind,
          via: ra.principalTitle || `group #${ra.principalId}`,
          roles: effectiveRoles,
          certain: true,
        });
        continue;
      }

      const audience = broadAudienceLabel(ra.principalLoginName);
      if (audience) {
        grantPaths.push({
          channel: 'broad-audience',
          scopeTitle: governing.title,
          scopeKind: governing.kind,
          via: audience,
          roles: effectiveRoles,
          certain: true,
          note: 'Grants to a very broad audience — every matching user is included.',
        });
        continue;
      }

      if (ra.principalType === PrincipalType.SecurityGroup) {
        unresolvedGroups.push({
          name: ra.principalTitle || ra.principalLoginName,
          scopeTitle: governing.title,
          roles: effectiveRoles,
        });
        grantPaths.push({
          channel: 'ad-group-unresolved',
          scopeTitle: governing.title,
          scopeKind: governing.kind,
          via: ra.principalTitle || ra.principalLoginName,
          roles: effectiveRoles,
          certain: false,
          note: 'AD security group — REST cannot expand its membership. The effective-permission result already accounts for it.',
        });
      }
    }
  }

  const fullControl = isFullControl(effectiveMask);
  const hasAccess = isSiteCollectionAdmin || canAccess(effectiveMask);

  if (isSiteCollectionAdmin) {
    notes.push(
      'User is a Site Collection Administrator — this grants Full Control everywhere and overrides all role assignments.',
    );
  }
  if (!hasAccess) {
    notes.push('Effective permissions are empty — the user has no access to this scope.');
  } else if (grantPaths.length === 0 && !isSiteCollectionAdmin) {
    notes.push(
      'The user has effective access, but no matching grant was found on this scope. Access likely comes from an AD security group on the ACL, or from a parent scope. Re-run with --verbose, or inspect the listed AD groups.',
    );
  }
  if (unresolvedGroups.length > 0) {
    notes.push(
      `${unresolvedGroups.length} AD security group(s) on this scope could not be expanded via REST. The effective-permission check above is still authoritative.`,
    );
  }

  return {
    user: {
      id: user.id,
      loginName: user.loginName,
      title: user.title,
      type: principalTypeName(user.principalType),
    },
    hasAccess,
    fullControl,
    effectivePermissions: grantedKinds(effectiveMask),
    siteCollectionAdmin: isSiteCollectionAdmin,
    brokenInheritanceAt,
    grantPaths,
    unresolvedGroups,
    notes,
  };
}

function lastIndexOf<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return i;
  }
  return -1;
}
