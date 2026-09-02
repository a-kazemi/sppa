/**
 * SharePoint permission-mask decoding.
 *
 * `getUserEffectivePermissions` and `EffectiveBasePermissions` return a 64-bit
 * mask split into two unsigned 32-bit halves (`High`, `Low`). Each named
 * PermissionKind is a bit *index* (1-based) into that 64-bit value.
 * Reference: Microsoft.SharePoint.Client.PermissionKind / SPBasePermissions.
 */

export interface PermMask {
  high: number;
  low: number;
}

/** Subset of PermissionKind indices that matter for an access explanation. */
export const PermissionKind: Record<string, number> = {
  ViewListItems: 1,
  AddListItems: 2,
  EditListItems: 3,
  DeleteListItems: 4,
  ApproveItems: 5,
  OpenItems: 6,
  ViewVersions: 7,
  ManageLists: 12,
  Open: 17,
  ViewPages: 18,
  AddAndCustomizePages: 19,
  ManageSubwebs: 24,
  CreateGroups: 25,
  ManagePermissions: 26,
  BrowseUserInfo: 28,
  EnumeratePermissions: 27,
  ManageWeb: 31,
  UseRemoteAPIs: 33,
  ManageAlerts: 34,
  EditMyUserInfo: 36,
};

/** Human-facing description for each kind we report on. */
export const PERMISSION_LABELS: Record<string, string> = {
  Open: 'Open the site',
  ViewPages: 'View pages',
  ViewListItems: 'View list items / documents',
  OpenItems: 'Open documents',
  AddListItems: 'Add list items / upload',
  EditListItems: 'Edit list items',
  DeleteListItems: 'Delete list items',
  ApproveItems: 'Approve items',
  ManageLists: 'Manage lists',
  AddAndCustomizePages: 'Add & customise pages',
  ManageSubwebs: 'Manage subsites',
  CreateGroups: 'Create groups',
  ManagePermissions: 'Manage permissions',
  ManageWeb: 'Manage the web',
  BrowseUserInfo: 'Browse user information',
  UseRemoteAPIs: 'Use remote APIs',
};

export function parseMask(input: { High?: string | number; Low?: string | number } | null | undefined): PermMask {
  const toNum = (v: string | number | undefined): number => {
    if (v === undefined || v === null) return 0;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n >>> 0 : 0;
  };
  return { high: toNum(input?.High), low: toNum(input?.Low) };
}

/** Test whether a mask contains a specific PermissionKind index (1-based). */
export function hasPermission(mask: PermMask, kindIndex: number): boolean {
  if (kindIndex <= 0) return false;
  const bit = kindIndex - 1;
  if (bit < 32) {
    // Use unsigned arithmetic; bit 31 would make (1 << 31) negative otherwise.
    return ((mask.low >>> bit) & 1) === 1;
  }
  return ((mask.high >>> (bit - 32)) & 1) === 1;
}

/** Full Control == every bit set in both halves. */
export function isFullControl(mask: PermMask): boolean {
  return mask.high === 0x7fffffff && mask.low === 0xffffffff;
}

export function isEmptyMask(mask: PermMask): boolean {
  return mask.high === 0 && mask.low === 0;
}

/** Names of the reportable permission kinds present in the mask. */
export function grantedKinds(mask: PermMask): string[] {
  if (isFullControl(mask)) return ['FullControl'];
  const out: string[] = [];
  for (const [name, idx] of Object.entries(PermissionKind)) {
    if (PERMISSION_LABELS[name] && hasPermission(mask, idx)) out.push(name);
  }
  return out;
}

/**
 * A principal can "reach" the site if it can Open it and view pages/items.
 * `getUserEffectivePermissions` already resolves group nesting server-side, so
 * an empty mask is an authoritative "no access".
 */
export function canAccess(mask: PermMask): boolean {
  if (isFullControl(mask)) return true;
  return hasPermission(mask, PermissionKind['Open']!) || hasPermission(mask, PermissionKind['ViewListItems']!);
}
