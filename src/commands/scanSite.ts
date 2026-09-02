import { NtlmHttpClient, Credentials } from '../auth/httpClient';
import { SharePointClient } from '../sp/client';
import { analyzeScan, ScanInput } from '../analysis/scanSite';
import { renderScanReport } from '../report/table';
import { renderJson, toJsonEnvelope } from '../report/json';
import { UsageError } from '../util/errors';

export interface ScanSiteOptions {
  site: string;
  format: 'table' | 'json';
  largeGroupThreshold: number;
  skipItems: boolean;
  maxItems: number;
  includeHidden: boolean;
  credentials: Credentials;
  insecure?: boolean;
  timeoutMs?: number;
  /** Progress callback for the CLI (stderr). */
  onProgress?: (message: string) => void;
}

export async function scanSite(opts: ScanSiteOptions): Promise<string> {
  if (!opts.site) throw new UsageError('--site is required');
  const progress = opts.onProgress ?? ((): void => {});

  const http = new NtlmHttpClient({
    credentials: opts.credentials,
    ...(opts.insecure === undefined ? {} : { insecure: opts.insecure }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  const sp = new SharePointClient(http, opts.site);

  try {
    progress('Connecting…');
    const web = await sp.connect();

    progress('Reading site users and groups…');
    const [webAssignments, siteUsers, siteGroups, lists] = await Promise.all([
      sp.getWebRoleAssignments(),
      sp.getSiteUsers(),
      sp.getSiteGroupsWithUsers(),
      sp.getLists(opts.includeHidden),
    ]);

    progress(`Scanning ${lists.length} list(s)…`);
    const analyzedLists: ScanInput['lists'] = [];
    for (const list of lists) {
      let assignments: ScanInput['lists'][number]['assignments'] = [];
      let uniqueItems: ScanInput['lists'][number]['uniqueItems'] = [];
      if (list.hasUniqueRoleAssignments) {
        assignments = await sp.getListRoleAssignments(list.title);
      }
      if (!opts.skipItems && list.itemCount > 0) {
        progress(`  ${list.title} (${list.itemCount} items)…`);
        uniqueItems = await sp.getUniqueItems(list.title, opts.maxItems);
      }
      analyzedLists.push({ ...list, assignments, uniqueItems });
    }

    const report = analyzeScan({
      web: {
        title: web.title,
        url: web.url,
        hasUniqueRoleAssignments: web.hasUniqueRoleAssignments,
        assignments: webAssignments,
      },
      lists: analyzedLists,
      siteUsers,
      siteGroups,
      largeGroupThreshold: opts.largeGroupThreshold,
    });

    if (opts.format === 'json') {
      return renderJson(toJsonEnvelope('scan-site', opts.site, report));
    }
    return renderScanReport(report);
  } finally {
    http.destroy();
  }
}
