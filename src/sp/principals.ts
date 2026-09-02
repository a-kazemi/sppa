/** Principal shapes and classification helpers. */

/** SP PrincipalType flags (Microsoft.SharePoint.Client.Utilities.PrincipalType). */
export const PrincipalType = {
  None: 0,
  User: 1,
  DistributionList: 2,
  SecurityGroup: 4,
  SharePointGroup: 8,
  All: 15,
} as const;

export interface Principal {
  id: number;
  loginName: string;
  title: string;
  email: string;
  principalType: number;
  isSiteAdmin: boolean;
}

export interface RoleAssignment {
  principalId: number;
  principalType: number;
  principalTitle: string;
  principalLoginName: string;
  /** Role definition names bound at this scope, e.g. ["Full Control"]. */
  roles: string[];
}

const SID_RE = /^S-1-\d+(-\d+){1,15}$/i;

/** A raw SID (used when SharePoint cannot resolve an account to a name). */
export function looksLikeSid(value: string): boolean {
  return SID_RE.test(value.trim());
}

/** Extract a trailing SID from a claims login name, if present. */
export function sidFromLogin(loginName: string): string | null {
  const tail = loginName.split('|').pop() ?? loginName;
  const cleaned = tail.replace(/^.*\\/, '').trim();
  return looksLikeSid(cleaned) ? cleaned : null;
}

export type OrphanConfidence = 'high' | 'medium';

export interface OrphanFinding {
  principal: Principal;
  confidence: OrphanConfidence;
  reason: string;
}

/**
 * Heuristic detection of orphaned principals — accounts left behind in the site
 * after the backing AD object was deleted or the account was removed from the
 * directory. SharePoint keeps the user entry but can no longer resolve a
 * friendly name, so the Title collapses to a raw SID.
 */
export function classifyOrphan(p: Principal): OrphanFinding | null {
  const type = p.principalType;
  const isUserLike = type === PrincipalType.User || type === PrincipalType.SecurityGroup;
  if (!isUserLike) return null;

  const titleIsSid = looksLikeSid(p.title);
  const loginSid = sidFromLogin(p.loginName);

  if (titleIsSid && loginSid && p.title.trim().toUpperCase() === loginSid.toUpperCase()) {
    return {
      principal: p,
      confidence: 'high',
      reason: 'Display name is an unresolved SID identical to the login SID.',
    };
  }
  if (titleIsSid) {
    return {
      principal: p,
      confidence: 'high',
      reason: 'Display name is a raw SID — SharePoint cannot resolve this account.',
    };
  }
  if (loginSid && p.email.trim() === '' && p.title.trim() === '') {
    return {
      principal: p,
      confidence: 'medium',
      reason: 'SID-based login with no display name and no email.',
    };
  }
  return null;
}

export function principalTypeName(type: number): string {
  switch (type) {
    case PrincipalType.User:
      return 'User';
    case PrincipalType.DistributionList:
      return 'Distribution list';
    case PrincipalType.SecurityGroup:
      return 'AD security group';
    case PrincipalType.SharePointGroup:
      return 'SharePoint group';
    default:
      return `Type ${type}`;
  }
}

const BROAD_LOGIN_MARKERS: Array<{ re: RegExp; label: string }> = [
  { re: /^c:0\(\.s\|true$/i, label: 'Everyone' },
  { re: /spo-grid-all-users/i, label: 'Everyone except external users' },
  { re: /\\authenticated users$/i, label: 'All authenticated Windows users' },
  { re: /^c:0!\.s\|windows$/i, label: 'All authenticated Windows users' },
  { re: /^c:0-\.f\|rolemanager\|/i, label: 'A federated role (all matching users)' },
];

/** If a principal represents a very broad audience, return a friendly label. */
export function broadAudienceLabel(loginName: string): string | null {
  for (const { re, label } of BROAD_LOGIN_MARKERS) {
    if (re.test(loginName.trim())) return label;
  }
  return null;
}
