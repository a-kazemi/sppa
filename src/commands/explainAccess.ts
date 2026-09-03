import { NtlmHttpClient, Credentials } from '../auth/httpClient';
import { SharePointClient } from '../sp/client';
import { buildAccessTrace, ScopeNode } from '../analysis/accessTrace';
import { renderAccessTrace } from '../report/table';
import { renderJson, toJsonEnvelope } from '../report/json';
import { UsageError } from '../util/errors';

export interface ExplainAccessOptions {
  site: string;
  targetUser: string;
  list?: string;
  windowsClaims?: boolean;
  format: 'table' | 'json';
  credentials: Credentials;
  insecure?: boolean;
  timeoutMs?: number;
}

/** i:0#.w| is the standard Windows-claims encoding prefix on classic farms. */
function withClaims(login: string, add: boolean): string {
  if (!add) return login;
  if (login.includes('|') || login.startsWith('i:0')) return login;
  return `i:0#.w|${login}`;
}

export async function explainAccess(opts: ExplainAccessOptions): Promise<string> {
  if (!opts.site) throw new UsageError('--site is required');
  if (!opts.targetUser) throw new UsageError('--user is required (the login to analyse)');

  const http = new NtlmHttpClient({
    credentials: opts.credentials,
    ...(opts.insecure === undefined ? {} : { insecure: opts.insecure }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  const sp = new SharePointClient(http, opts.site);

  try {
    const web = await sp.connect();

    const login = withClaims(opts.targetUser, Boolean(opts.windowsClaims));
    let user = await sp.findUser(login);
    if (!user && login !== opts.targetUser) {
      user = await sp.findUser(opts.targetUser);
    }
    if (!user) {
      throw new UsageError(
        `User "${opts.targetUser}" was not found among this site's users.`,
        'Pass the exact login name. For classic Windows-claims farms try --windows-claims, ' +
          'or pass the full claim, e.g. "i:0#.w|CONTOSO\\a.kazemi".',
      );
    }

    const [effectiveMask, userGroupIds, webAssignments] = await Promise.all([
      opts.list
        ? sp.getListUserEffectivePermissions(opts.list, user.loginName)
        : sp.getUserEffectivePermissions(user.loginName),
      sp.getUserGroupIds(user.id),
      sp.getWebRoleAssignments(),
    ]);

    const path: ScopeNode[] = [
      {
        kind: 'web',
        title: web.title || web.url,
        url: web.url,
        hasUniqueRoleAssignments: web.hasUniqueRoleAssignments,
        assignments: webAssignments,
      },
    ];

    if (opts.list) {
      const lists = await sp.getLists(true);
      const meta = lists.find((l) => l.title.toLowerCase() === opts.list!.toLowerCase());
      const listAssignments = await sp.getListRoleAssignments(opts.list);
      path.push({
        kind: 'list',
        title: opts.list,
        hasUniqueRoleAssignments: meta?.hasUniqueRoleAssignments ?? true,
        assignments: listAssignments,
      });
    }

    const result = buildAccessTrace({
      user,
      effectiveMask,
      userGroupIds,
      path,
      isSiteCollectionAdmin: user.isSiteAdmin,
    });

    if (opts.format === 'json') {
      return renderJson(toJsonEnvelope('explain-access', opts.site, result));
    }
    return renderAccessTrace(result, opts.site);
  } finally {
    http.destroy();
  }
}
