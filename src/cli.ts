/** Argument parsing and command dispatch. No external dependencies. */

import { Credentials } from './auth/httpClient';
import { explainAccess } from './commands/explainAccess';
import { scanSite } from './commands/scanSite';
import { listAccess } from './commands/listAccess';
import { UsageError } from './util/errors';
import { color } from './util/ansi';
import { VERSION } from './version';

interface ParsedArgs {
  _: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const _: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      _.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, true);
        }
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function str(flags: Map<string, string | boolean>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function bool(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true || flags.get(name) === 'true';
}

function int(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const v = str(flags, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number`);
  return Math.floor(n);
}

function format(flags: Map<string, string | boolean>): 'table' | 'json' {
  const v = str(flags, 'format') ?? 'table';
  if (v !== 'table' && v !== 'json') throw new UsageError(`--format must be "table" or "json"`);
  return v;
}

/** `./sppa-scan-<host>-<YYYYMMDD-HHMMSS>.html` in the current directory. */
function defaultReportPath(site: string): string {
  let host = 'site';
  try {
    host = new URL(site).host.replace(/[^a-z0-9.-]/gi, '_') || 'site';
  } catch {
    /* keep fallback */
  }
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `sppa-scan-${host}-${ts}.html`;
}

function resolveCredentials(flags: Map<string, string | boolean>): Credentials {
  let username = str(flags, 'username') ?? process.env['SPPA_USERNAME'] ?? '';
  let domain = str(flags, 'domain') ?? process.env['SPPA_DOMAIN'] ?? '';
  const password = str(flags, 'password') ?? process.env['SPPA_PASSWORD'] ?? '';

  if (username.includes('\\')) {
    const [d, u] = username.split('\\');
    if (!domain) domain = d ?? '';
    username = u ?? '';
  }

  if (!username || !password) {
    throw new UsageError(
      'Missing credentials.',
      'Set SPPA_USERNAME and SPPA_PASSWORD (recommended), or pass --username / --password. ' +
        'Use DOMAIN\\user, or add --domain. See docs/AUTH.md.',
    );
  }
  if (str(flags, 'password') !== undefined) {
    process.stderr.write(
      color.yellow('warning: --password is visible in the process list; prefer SPPA_PASSWORD\n'),
    );
  }
  const workstation = str(flags, 'workstation');
  return { username, password, domain, ...(workstation === undefined ? {} : { workstation }) };
}

const HELP = `${color.bold('sppa')} v${VERSION}
Explain and audit SharePoint Server on-premises permissions. Read-only.

${color.bold('USAGE')}
  sppa <command> [options]

${color.bold('COMMANDS')}
  explain-access   Explain why a user does or does not have access to a site/list
  list-access      List every principal that has access to a site/list, and how
  scan-site        Audit one site collection: broken inheritance, orphaned SIDs,
                   broad grants, oversized groups, site collection admins

${color.bold('COMMON OPTIONS')}
  --site <url>            SharePoint site collection or web URL (required)
  --format table|json     Output format (default: table)
  --insecure              Do not verify TLS certificates (self-signed farms)
  --timeout <ms>          Per-request timeout (default: 30000)
  --concurrency <n>       Parallel authenticated connections (default: 1)
  --username <user>       Auth account; or set SPPA_USERNAME. Accepts DOMAIN\\user
  --password <pass>       Auth password; prefer SPPA_PASSWORD (env)
  --domain <domain>       NetBIOS domain; or set SPPA_DOMAIN
  -h, --help              Show this help
  -v, --version           Show version

${color.bold('explain-access OPTIONS')}
  --user <login>          Login to analyse, e.g. "CONTOSO\\a.kazemi" (required)
  --list <title>          Analyse a specific list instead of the web
  --windows-claims        Auto-prefix the login with i:0#.w| for classic farms

${color.bold('list-access OPTIONS')}
  --list <title>          List access to a specific list instead of the web

${color.bold('scan-site OPTIONS')}
  --large-group-threshold <n>   Flag SharePoint groups with >= n members (default: 100)
  --skip-items                  Do not scan list items for unique permissions
  --max-items <n>               Max items to scan per list (default: 20000)
  --include-hidden             Include hidden lists
  --recurse                    Walk subwebs (web/webs) and merge their findings
  --concurrency <n>            Parallel connections; speeds up a large scan (default: 1)
  --report <path>              HTML report path (default: ./sppa-scan-<host>-<time>.html)
  --no-report                  Do not write the HTML report

${color.bold('EXAMPLES')}
  export SPPA_USERNAME='CONTOSO\\svc_audit' SPPA_PASSWORD='***'
  sppa explain-access --site https://sp/sites/hr --user 'CONTOSO\\a.kazemi'
  sppa list-access --site https://sp/sites/hr --list 'Salary Review'
  sppa scan-site --site https://sp/sites/hr --recurse --format json > hr-audit.json

Exit codes: 0 ok · 2 usage · 3 auth · 4 API · 5 network
`;

export async function run(argv: string[]): Promise<number> {
  const { _, flags } = parseArgs(argv);
  const wantsHelp = flags.has('help') || argv.includes('-h') || _[0] === 'help';
  const wantsVersion = flags.has('version') || argv.includes('-v');

  if (wantsVersion) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (wantsHelp) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (_.length === 0) {
    process.stderr.write(HELP + '\n');
    return 2;
  }

  const command = _[0];
  const timeoutFlag = str(flags, 'timeout');
  const timeoutMs = timeoutFlag === undefined ? undefined : int(flags, 'timeout', 30000);
  const concurrency =
    str(flags, 'concurrency') === undefined ? undefined : Math.max(1, int(flags, 'concurrency', 1));

  switch (command) {
    case 'explain-access': {
      const site = str(flags, 'site') ?? '';
      const targetUser = str(flags, 'user') ?? '';
      const list = str(flags, 'list');
      const output = await explainAccess({
        site,
        targetUser,
        ...(list === undefined ? {} : { list }),
        windowsClaims: bool(flags, 'windows-claims'),
        format: format(flags),
        credentials: resolveCredentials(flags),
        insecure: bool(flags, 'insecure'),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(concurrency === undefined ? {} : { concurrency }),
      });
      process.stdout.write(output + '\n');
      return 0;
    }
    case 'list-access': {
      const site = str(flags, 'site') ?? '';
      const list = str(flags, 'list');
      const output = await listAccess({
        site,
        ...(list === undefined ? {} : { list }),
        format: format(flags),
        credentials: resolveCredentials(flags),
        insecure: bool(flags, 'insecure'),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(concurrency === undefined ? {} : { concurrency }),
      });
      process.stdout.write(output + '\n');
      return 0;
    }
    case 'scan-site': {
      const site = str(flags, 'site') ?? '';
      const fmt = format(flags);
      const htmlReportPath =
        fmt === 'json' || bool(flags, 'no-report')
          ? undefined
          : (str(flags, 'report') ?? defaultReportPath(site));
      const output = await scanSite({
        site,
        format: fmt,
        largeGroupThreshold: int(flags, 'large-group-threshold', 100),
        skipItems: bool(flags, 'skip-items'),
        maxItems: int(flags, 'max-items', 20000),
        includeHidden: bool(flags, 'include-hidden'),
        recurse: bool(flags, 'recurse'),
        credentials: resolveCredentials(flags),
        insecure: bool(flags, 'insecure'),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(concurrency === undefined ? {} : { concurrency }),
        ...(htmlReportPath === undefined ? {} : { htmlReportPath }),
        onProgress: (m) => process.stderr.write(color.dim(m) + '\n'),
      });
      process.stdout.write(output + '\n');
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${command ?? ''}". Run "sppa --help".`);
  }
}
