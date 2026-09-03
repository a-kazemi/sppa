import { NtlmHttpClient, Credentials } from '../auth/httpClient';
import { SharePointClient } from '../sp/client';
import { analyzeListAccess, ListAccessInput } from '../analysis/listAccess';
import { renderListAccess } from '../report/table';
import { renderJson, toJsonEnvelope } from '../report/json';
import { UsageError } from '../util/errors';
import { Principal } from '../sp/principals';

export interface ListAccessOptions {
  site: string;
  list?: string;
  format: 'table' | 'json';
  credentials: Credentials;
  insecure?: boolean;
  timeoutMs?: number;
  concurrency?: number;
}

/** Enumerate every principal that has access to a web or list, and how. */
export async function listAccess(opts: ListAccessOptions): Promise<string> {
  if (!opts.site) throw new UsageError('--site is required');

  const http = new NtlmHttpClient({
    credentials: opts.credentials,
    ...(opts.insecure === undefined ? {} : { insecure: opts.insecure }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
  });
  const sp = new SharePointClient(http, opts.site);

  try {
    const web = await sp.connect();
    const [webAssignments, siteGroups, siteUsers] = await Promise.all([
      sp.getWebRoleAssignments(),
      sp.getSiteGroupsWithUsers(),
      sp.getSiteUsers(),
    ]);

    let scope: ListAccessInput['scope'] = {
      kind: 'web',
      title: web.title || web.url,
      url: web.url,
    };
    let inheritedFromParent = false;
    let governingScopeTitle = web.title || web.url;
    let assignments = webAssignments;

    if (opts.list) {
      const meta = await sp.resolveList(opts.list);
      if (!meta) {
        throw new UsageError(
          `List "${opts.list}" was not found on this site.`,
          'Pass the list title as it appears in SharePoint (spaces and all), not the URL segment.',
        );
      }
      scope = { kind: 'list', title: meta.title };
      if (meta.hasUniqueRoleAssignments) {
        assignments = await sp.getListRoleAssignments(meta.title);
        governingScopeTitle = meta.title;
      } else {
        inheritedFromParent = true;
        // governing scope stays the web; assignments already fetched above.
      }
    }

    const groupMembers = new Map<number, Principal[]>(siteGroups.map((g) => [g.id, g.users]));
    const emailByLogin = new Map<string, string>();
    for (const u of siteUsers) {
      if (u.email) emailByLogin.set(u.loginName.toLowerCase(), u.email);
    }
    const siteCollectionAdmins = siteUsers
      .filter((u) => u.isSiteAdmin)
      .map((u) => ({ loginName: u.loginName, title: u.title }));

    const result = analyzeListAccess({
      scope,
      inheritedFromParent,
      governingScopeTitle,
      assignments,
      groupMembers,
      emailByLogin,
      siteCollectionAdmins,
    });

    if (opts.format === 'json') {
      return renderJson(toJsonEnvelope('list-access', opts.site, result));
    }
    return renderListAccess(result, opts.site);
  } finally {
    http.destroy();
  }
}
