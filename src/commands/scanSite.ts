import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NtlmHttpClient, Credentials } from '../auth/httpClient';
import { SharePointClient, WebInfo } from '../sp/client';
import { analyzeScan, mergeScanReports, ScanInput, ScanReport } from '../analysis/scanSite';
import { renderScanReport } from '../report/table';
import { renderScanHtml } from '../report/html';
import { renderJson, toJsonEnvelope } from '../report/json';
import { color } from '../util/ansi';
import { UsageError } from '../util/errors';

export interface ScanSiteOptions {
  site: string;
  format: 'table' | 'json';
  largeGroupThreshold: number;
  skipItems: boolean;
  maxItems: number;
  includeHidden: boolean;
  /** Walk subwebs (`web/webs`) recursively and merge their findings. */
  recurse?: boolean;
  credentials: Credentials;
  insecure?: boolean;
  timeoutMs?: number;
  /** Parallel authenticated connections (see NtlmHttpClient). Default 1. */
  concurrency?: number;
  /**
   * Write a standalone HTML report to this path and append a link to the
   * terminal output. Ignored when `format` is `json`. Undefined = no file.
   */
  htmlReportPath?: string;
  /** Progress callback for the CLI (stderr). */
  onProgress?: (message: string) => void;
}

/** Depth/breadth guard for `--recurse` so a pathological tree cannot run away. */
const MAX_WEBS = 500;

export async function scanSite(opts: ScanSiteOptions): Promise<string> {
  if (!opts.site) throw new UsageError('--site is required');
  const progress = opts.onProgress ?? ((): void => {});

  const http = new NtlmHttpClient({
    credentials: opts.credentials,
    ...(opts.insecure === undefined ? {} : { insecure: opts.insecure }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
  });
  const rootSp = new SharePointClient(http, opts.site);

  try {
    progress('Connecting…');
    const rootWeb = await rootSp.connect();

    const targets: Array<{ sp: SharePointClient; web: WebInfo }> = [{ sp: rootSp, web: rootWeb }];

    if (opts.recurse) {
      progress('Enumerating subwebs…');
      const queue = [{ sp: rootSp, web: rootWeb }];
      while (queue.length && targets.length < MAX_WEBS) {
        const current = queue.shift()!;
        const children = await current.sp.getSubWebs();
        for (const child of children) {
          if (targets.length >= MAX_WEBS) break;
          const childSp = current.sp.forWeb(child.url);
          targets.push({ sp: childSp, web: child });
          queue.push({ sp: childSp, web: child });
        }
      }
      progress(`Scanning ${targets.length} web(s)…`);
    }

    const reports: ScanReport[] = [];
    for (const target of targets) {
      const label = opts.recurse ? `${target.web.title || target.web.serverRelativeUrl}: ` : '';
      reports.push(await scanOneWeb(target.sp, target.web, opts, progress, label));
    }

    const report = opts.recurse ? mergeScanReports(reports) : reports[0]!;
    const envelope = toJsonEnvelope('scan-site', opts.site, report);

    if (opts.format === 'json') {
      return renderJson(envelope);
    }

    let text = renderScanReport(report);
    if (opts.htmlReportPath) {
      const abs = resolve(opts.htmlReportPath);
      try {
        writeFileSync(abs, renderScanHtml(envelope), 'utf8');
        text += '\n' + color.dim('Report: ') + pathToFileURL(abs).href;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        progress(`warning: could not write HTML report to ${abs}: ${reason}`);
      }
    }
    return text;
  } finally {
    http.destroy();
  }
}

async function scanOneWeb(
  sp: SharePointClient,
  web: WebInfo,
  opts: ScanSiteOptions,
  progress: (m: string) => void,
  label: string,
): Promise<ScanReport> {
  progress(`${label}Reading site users and groups…`);
  const [webAssignments, siteUsers, siteGroups, lists] = await Promise.all([
    sp.getWebRoleAssignments(),
    sp.getSiteUsers(),
    sp.getSiteGroupsWithUsers(),
    sp.getLists(opts.includeHidden),
  ]);

  progress(`${label}Scanning ${lists.length} list(s)…`);
  const analyzedLists: ScanInput['lists'] = [];
  for (const list of lists) {
    let assignments: ScanInput['lists'][number]['assignments'] = [];
    let uniqueItems: ScanInput['lists'][number]['uniqueItems'] = [];
    if (list.hasUniqueRoleAssignments) {
      assignments = await sp.getListRoleAssignments(list.title);
    }
    if (!opts.skipItems && list.itemCount > 0) {
      progress(`${label}  ${list.title} (${list.itemCount} items)…`);
      uniqueItems = await sp.getUniqueItems(list.title, opts.maxItems);
    }
    analyzedLists.push({ ...list, assignments, uniqueItems });
  }

  return analyzeScan({
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
    ...(opts.recurse ? { webUrl: web.serverRelativeUrl || web.url } : {}),
  });
}
