/** Thin read-only wrapper over the SharePoint REST (`_api`) surface. */

import { NtlmHttpClient } from '../auth/httpClient';
import { ApiError, AuthError } from '../util/errors';
import { parseMask, PermMask } from './permissions';
import { Principal, RoleAssignment } from './principals';

interface ODataList<T> {
  value?: T[];
  d?: { results?: T[]; __next?: string };
  'odata.nextLink'?: string;
}

export interface WebInfo {
  title: string;
  url: string;
  serverRelativeUrl: string;
  hasUniqueRoleAssignments: boolean;
}

export interface ListInfo {
  id: string;
  title: string;
  hasUniqueRoleAssignments: boolean;
  baseTemplate: number;
  itemCount: number;
  hidden: boolean;
}

export interface UniqueItem {
  id: number;
  fileRef: string;
  assignments: RoleAssignment[];
}

export class SharePointClient {
  private readonly base: string;

  constructor(private readonly http: NtlmHttpClient, siteUrl: string) {
    this.base = siteUrl.replace(/\/+$/, '');
  }

  private async getJson(apiPath: string): Promise<any> {
    const url = `${this.base}/_api/${apiPath.replace(/^\/+/, '')}`;
    const res = await this.http.request({
      method: 'GET',
      url,
      headers: { Accept: 'application/json;odata=nometadata' },
    });
    if (res.status === 401) {
      throw new AuthError(`Not authorised for ${url}`);
    }
    if (res.status === 404) {
      throw new ApiError(`Not found: ${url}`, 'Check the --site URL and object name.');
    }
    if (res.status >= 400) {
      const snippet = res.body.toString('utf8').slice(0, 400).replace(/\s+/g, ' ');
      throw new ApiError(`SharePoint returned HTTP ${res.status} for ${url}`, snippet || undefined);
    }
    try {
      return JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new ApiError(
        `SharePoint returned a non-JSON response for ${url}`,
        'The URL may be a sign-in page (auth misconfiguration) rather than the API.',
      );
    }
  }

  private static rows<T>(payload: ODataList<T>): T[] {
    if (Array.isArray(payload.value)) return payload.value;
    if (payload.d?.results) return payload.d.results;
    return [];
  }

  private async getAll<T>(apiPath: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = apiPath;
    let guard = 0;
    while (next && guard++ < 500) {
      const payload: ODataList<T> = await this.getJson(next);
      out.push(...SharePointClient.rows(payload));
      const link = payload['odata.nextLink'] ?? payload.d?.__next ?? null;
      next = link ? link.replace(/^.*\/_api\//, '') : null;
    }
    return out;
  }

  /** Verify connectivity + auth early with a cheap call. */
  async connect(): Promise<WebInfo> {
    return this.getWeb();
  }

  /** A client rebased on a subweb URL, sharing this authenticated connection. */
  forWeb(webUrl: string): SharePointClient {
    return new SharePointClient(this.http, webUrl);
  }

  /** Immediate child webs of this web (one level; recurse by calling again). */
  async getSubWebs(): Promise<WebInfo[]> {
    const rows = await this.getAll<any>(
      'web/webs?$select=Title,Url,ServerRelativeUrl,HasUniqueRoleAssignments',
    );
    return rows.map((w) => ({
      title: w.Title ?? '',
      url: w.Url ?? '',
      serverRelativeUrl: w.ServerRelativeUrl ?? '',
      hasUniqueRoleAssignments: Boolean(w.HasUniqueRoleAssignments),
    }));
  }

  /** One list by title, or null when it does not exist (404). */
  async getListByTitle(listTitle: string): Promise<ListInfo | null> {
    const encList = encodeURIComponent(listTitle.replace(/'/g, "''"));
    try {
      const l = await this.getJson(
        `web/lists/getByTitle('${encList}')?$select=Id,Title,HasUniqueRoleAssignments,BaseTemplate,ItemCount,Hidden`,
      );
      return {
        id: String(l.Id),
        title: l.Title ?? '',
        hasUniqueRoleAssignments: Boolean(l.HasUniqueRoleAssignments),
        baseTemplate: Number(l.BaseTemplate ?? 0),
        itemCount: Number(l.ItemCount ?? 0),
        hidden: Boolean(l.Hidden),
      };
    } catch (err) {
      if (err instanceof ApiError && /Not found/.test(err.message)) return null;
      throw err;
    }
  }

  async getWeb(): Promise<WebInfo> {
    const w = await this.getJson(
      'web?$select=Title,Url,ServerRelativeUrl,HasUniqueRoleAssignments',
    );
    return {
      title: w.Title ?? '',
      url: w.Url ?? this.base,
      serverRelativeUrl: w.ServerRelativeUrl ?? '/',
      hasUniqueRoleAssignments: Boolean(w.HasUniqueRoleAssignments),
    };
  }

  /** Resolve a login name to a site user. Returns null when not present. */
  async findUser(loginName: string): Promise<Principal | null> {
    const enc = loginName.replace(/'/g, "''");
    const rows = await this.getAll<any>(
      `web/siteusers?$select=Id,LoginName,Title,Email,PrincipalType,IsSiteAdmin&$filter=LoginName eq '${encodeURIComponent(
        enc,
      )}'`,
    );
    const u = rows[0];
    if (!u) return null;
    return toPrincipal(u);
  }

  async getUserEffectivePermissions(loginName: string): Promise<PermMask> {
    const enc = encodeURIComponent(loginName.replace(/'/g, "''"));
    const res = await this.getJson(`web/getUserEffectivePermissions(@u)?@u='${enc}'`);
    // nometadata: { High, Low }; verbose: { GetUserEffectivePermissions: { High, Low } }
    return parseMask(res.GetUserEffectivePermissions ?? res.value ?? res);
  }

  async getListUserEffectivePermissions(listTitle: string, loginName: string): Promise<PermMask> {
    const encUser = encodeURIComponent(loginName.replace(/'/g, "''"));
    const encList = encodeURIComponent(listTitle.replace(/'/g, "''"));
    const res = await this.getJson(
      `web/lists/getByTitle('${encList}')/getUserEffectivePermissions(@u)?@u='${encUser}'`,
    );
    return parseMask(res.GetUserEffectivePermissions ?? res.value ?? res);
  }

  async getWebRoleAssignments(): Promise<RoleAssignment[]> {
    return this.roleAssignments('web/roleassignments');
  }

  async getListRoleAssignments(listTitle: string): Promise<RoleAssignment[]> {
    const encList = encodeURIComponent(listTitle.replace(/'/g, "''"));
    return this.roleAssignments(`web/lists/getByTitle('${encList}')/roleassignments`);
  }

  private async roleAssignments(path: string): Promise<RoleAssignment[]> {
    const rows = await this.getAll<any>(
      `${path}?$expand=Member,RoleDefinitionBindings&$select=PrincipalId,Member/Id,Member/Title,Member/LoginName,Member/PrincipalType,RoleDefinitionBindings/Name`,
    );
    return rows.map((r) => ({
      principalId: Number(r.PrincipalId ?? r.Member?.Id ?? 0),
      principalType: Number(r.Member?.PrincipalType ?? 0),
      principalTitle: r.Member?.Title ?? '',
      principalLoginName: r.Member?.LoginName ?? '',
      roles: (r.RoleDefinitionBindings ?? []).map((b: any) => b.Name).filter(Boolean),
    }));
  }

  /** SharePoint groups the given user id is a direct member of. */
  async getUserGroupIds(userId: number): Promise<number[]> {
    const rows = await this.getAll<any>(
      `web/getUserById(${userId})/groups?$select=Id`,
    );
    return rows.map((g) => Number(g.Id)).filter((n) => Number.isFinite(n));
  }

  async getSiteUsers(): Promise<Principal[]> {
    const rows = await this.getAll<any>(
      'web/siteusers?$select=Id,LoginName,Title,Email,PrincipalType,IsSiteAdmin',
    );
    return rows.map(toPrincipal);
  }

  async getSiteGroupsWithUsers(): Promise<Array<{ id: number; title: string; ownerTitle: string; users: Principal[] }>> {
    const rows = await this.getAll<any>(
      'web/sitegroups?$expand=Users,Owner&$select=Id,Title,Owner/Title,Users/Id,Users/LoginName,Users/Title,Users/Email,Users/PrincipalType,Users/IsSiteAdmin',
    );
    return rows.map((g) => ({
      id: Number(g.Id),
      title: g.Title ?? '',
      ownerTitle: g.Owner?.Title ?? '',
      users: (g.Users ?? []).map(toPrincipal),
    }));
  }

  async getLists(includeHidden = false): Promise<ListInfo[]> {
    const rows = await this.getAll<any>(
      'web/lists?$select=Id,Title,HasUniqueRoleAssignments,BaseTemplate,ItemCount,Hidden',
    );
    return rows
      .map((l) => ({
        id: String(l.Id),
        title: l.Title ?? '',
        hasUniqueRoleAssignments: Boolean(l.HasUniqueRoleAssignments),
        baseTemplate: Number(l.BaseTemplate ?? 0),
        itemCount: Number(l.ItemCount ?? 0),
        hidden: Boolean(l.Hidden),
      }))
      .filter((l) => includeHidden || !l.hidden);
  }

  /**
   * Items in a list that have unique (broken-inheritance) role assignments.
   * Paged manually; capped by `maxItems` to keep large libraries bounded.
   */
  async getUniqueItems(listTitle: string, maxItems: number): Promise<UniqueItem[]> {
    const encList = encodeURIComponent(listTitle.replace(/'/g, "''"));
    const found: UniqueItem[] = [];
    let scanned = 0;
    let path: string | null =
      `web/lists/getByTitle('${encList}')/items?$select=Id,HasUniqueRoleAssignments,FileRef&$top=500`;
    let guard = 0;
    while (path && scanned < maxItems && guard++ < 1000) {
      const payload: ODataList<any> = await this.getJson(path);
      const rows = SharePointClient.rows<any>(payload);
      for (const it of rows) {
        scanned++;
        if (it.HasUniqueRoleAssignments) {
          const assignments = await this.roleAssignments(
            `web/lists/getByTitle('${encList}')/items(${it.Id})/roleassignments`,
          );
          found.push({ id: Number(it.Id), fileRef: it.FileRef ?? '', assignments });
        }
      }
      const link = payload['odata.nextLink'] ?? payload.d?.__next ?? null;
      path = link ? link.replace(/^.*\/_api\//, '') : null;
    }
    return found;
  }
}

function toPrincipal(u: any): Principal {
  return {
    id: Number(u.Id ?? 0),
    loginName: u.LoginName ?? '',
    title: u.Title ?? '',
    email: u.Email ?? '',
    principalType: Number(u.PrincipalType ?? 0),
    isSiteAdmin: Boolean(u.IsSiteAdmin),
  };
}
