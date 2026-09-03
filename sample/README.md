# Worked example — synthetic farm

Everything in this folder is **synthetic**. There is no real SharePoint farm
called `contoso.local`; the data was written by hand to exercise every finding
the tool produces. Use it to see what `spperm` reports *before* you point it at
your own farm.

## The fictional farm

Site collection `https://sp.contoso.local/sites/hr` ("Human Resources"), a
SharePoint Server 2019 on-prem farm. It deliberately contains one of each thing
the tool looks for:

| Object | What is wrong / notable |
|---|---|
| Web `Human Resources` | Inheritance broken at the site root |
| `Everyone` (`c:0(.s\|true`) on the web ACL | Broad-audience grant — every authenticated user gets Read |
| `CONTOSO\HR-Admins` (AD security group) on the web ACL | Membership can't be expanded over REST — surfaced but marked uncertain |
| List `Salaries` | Inheritance broken at the list |
| `Salaries/2024 Executive Compensation.xlsx` | Inheritance broken at the item; a direct grant to Jane Doe |
| `S-1-5-21-…-2571` | Orphaned principal — display name collapsed to a raw SID, still on the `Salaries` ACL |
| `CONTOSO\Payroll` (AD security group) on the `Salaries` ACL | Membership can't be expanded over REST — surfaced but marked uncertain |
| SharePoint group `All HR Staff` | 112 members — oversized group |
| `Mark Adams` | Site collection administrator |
| `Rachel Lee` (`contoso\rlee`) | Contractor — a site user, but on none of the `Salaries` ACL entries; used for the DENY example below |
| Lists `Documents`, `Onboarding` | Healthy — inherit permissions, no unique items |
| List `Workflow History` | Hidden — excluded from the scan by default |

## Files

| Path | What it is |
|---|---|
| `api/*.json` | The recorded SharePoint `_api` (REST) response bodies for the farm above — the tool's raw input |
| `scan-site.json` / `scan-site.txt` | `spperm scan-site --site https://sp.contoso.local/sites/hr` output, JSON and table |
| `explain-access.json` / `explain-access.txt` | `spperm explain-access --site https://sp.contoso.local/sites/hr --user 'i:0#.w\|contoso\jane'` output — an **ALLOW** trace at the web scope |
| `explain-access-deny.json` / `explain-access-deny.txt` | `spperm explain-access --site https://sp.contoso.local/sites/hr --user 'i:0#.w\|contoso\rlee' --list Salaries` output — a **DENY** trace at a list scope |

`generatedAt` in the committed JSON is zeroed to `1970-01-01T00:00:00.000Z`; the
real CLI stamps the current time.

### Reading the DENY example

`Verdict: NO ACCESS` comes straight from `getUserEffectivePermissions` on the
list, which returns an empty mask for Rachel Lee. The trace still lists the
`CONTOSO\Payroll` AD security group that sits on the `Salaries` ACL and marks it
`?` — REST cannot expand its membership, so the tool cannot *prove* she is absent
from it. The empty effective-permission mask is authoritative regardless: if she
were a member of `CONTOSO\Payroll`, the mask would not have come back empty. This
is the tool being explicit about what it can and cannot verify.

## How it is kept honest

`test/sample.test.ts` feeds `api/*.json` through the real parsing layer
(`SharePointClient`), the real analysis, and the real renderers, then checks the
output here still matches. If a code change moves the output, the test fails until
the sample is regenerated (`UPDATE_SAMPLES=1 npm run test:only`, or delete the
generated files and re-run the tests). So this example can't silently drift.

The one thing it does **not** cover is the NTLM handshake against a live server —
that still needs a real farm.
