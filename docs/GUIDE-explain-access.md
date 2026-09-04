# Explaining SharePoint Server on-prem access: who can see the HR site, and why?

## The task

Someone asks you to confirm who can see the HR site, and why each of them can. You
are on SharePoint Server 2016, 2019, or Subscription Edition. There is no single
screen that answers this.

What you actually do by hand:

- Start at the site collection root, check whether the web inherits permissions or
  has its own role assignments.
- Walk down to each list and library and check the same thing.
- Walk into individual items that have unique permissions.
- At every scope where inheritance is broken, read the role assignments.
- For each assignment, work out what the principal is: a user, a SharePoint group,
  a claim like "Everyone", or an AD security group.
- Expand every SharePoint group to its members.
- Expand every AD security group — which means leaving SharePoint and going to
  Active Directory.
- Keep track of which permission level each grant carries and at which scope.

For one user on one site that is maybe twenty minutes of clicking and PowerShell if
nothing is unusual. Across a whole site collection, under audit pressure, it is a
day you did not plan to spend.

`sppa explain-access` does that walk for one user and prints the result. It is
read-only: it issues `GET` requests to the SharePoint REST API (`_api`) and nothing
else. Below is a full worked example against a synthetic farm that ships with the
tool, so you can read the output before pointing it at anything real.

## The synthetic farm

The [`sample/`](https://github.com/a-kazemi/sppa/tree/main/sample)
folder in the repo contains a hand-built SharePoint Server 2019 site collection,
`https://sp.contoso.local/sites/hr` ("Human Resources"). It is recorded `_api`
response bodies plus the exact output the tool produces from them. A test
regenerates that output from the fixtures on every run, so it cannot drift from the
code.

The farm deliberately contains one of everything the tool looks for: inheritance
broken at the web, at a list, and at an item; an `Everyone` grant; two AD security
groups on ACLs; an orphaned SID; an oversized SharePoint group; a site collection
administrator.

## The ALLOW trace

Command:

```
sppa explain-access --site https://sp.contoso.local/sites/hr --user 'i:0#.w|contoso\jane'
```

Output:

```
SharePoint access explanation
Site: https://sp.contoso.local/sites/hr
User: Jane Doe (User, id 8)
Login: i:0#.w|contoso\jane

Verdict: HAS ACCESS

Effective permissions on this scope:
  • View list items / documents
  • Open documents
  • Open the site
  • View pages
  • Browse user information
  • Use remote APIs

Inheritance is broken at:
  • web: Human Resources

How access is granted:
  ✓ SharePoint group "HR Members" — Read @ web "Human Resources"
  ✓ Broad audience: Everyone — Read @ web "Human Resources"
      Grants to a very broad audience — every matching user is included.
  ? AD security group "CONTOSO\HR-Admins" (membership not verifiable via REST) — Full Control @ web "Human Resources"
      AD security group — REST cannot expand its membership. The effective-permission result already accounts for it.

AD security groups on the ACL (not expanded):
  • CONTOSO\HR-Admins — Full Control @ Human Resources

Notes:
  • 1 AD security group(s) on this scope could not be expanded via REST. The effective-permission check above is still authoritative.
```

Reading it line by line.

**Verdict: HAS ACCESS** comes from `getUserEffectivePermissions` — a REST call that
asks the server directly what this user can do at this scope. It is the server's
own answer, not something the tool computes from the ACL. The bullet list under
"Effective permissions on this scope" is that permission mask translated into base
permission names.

**Inheritance is broken at: web: Human Resources.** The tool walked from the site
collection root and found that the web itself does not inherit — it carries its own
role assignments. Everything below it that still inherits is governed by this ACL.
If the break were at a list or an item, that is the line that would name it.

**How access is granted** is the tool matching the user against each role
assignment on that broken scope, and saying why the verdict came out the way it
did:

- `✓ SharePoint group "HR Members" — Read @ web "Human Resources"` — Jane is a
  member of the SharePoint group `HR Members`, and that group has the Read
  permission level on the web. The tool expanded the group over REST and found her
  in it. Confirmed.
- `✓ Broad audience: Everyone — Read @ web "Human Resources"` — there is an
  `Everyone` claim (`c:0(.s|true`) on the ACL with Read. Every authenticated user
  matches it, so Jane does too. The tool calls this out separately because a grant
  like this is easy to miss and is rarely what you want at a scope like an HR site.
- `? AD security group "CONTOSO\HR-Admins" ... — Full Control @ web "Human Resources"` —
  there is an AD security group on the ACL with Full Control. The tool cannot
  expand an AD group over the SharePoint REST API; SharePoint does not expose that
  membership. So it cannot say whether Jane is in `CONTOSO\HR-Admins`. It marks the
  line `?` and surfaces the group rather than guessing.

The `?` line is why the **Notes** section restates that the effective-permission
check is authoritative. The verdict does not depend on the tool resolving that AD
group: `getUserEffectivePermissions` runs server-side, where the AD group *is*
resolved. If Jane were a Full Control member of `CONTOSO\HR-Admins`, her effective
permissions would show it. They do not — she has a Read-level mask — so the
confirmed path is the SharePoint group plus the `Everyone` claim. The `?` marks
what the tool could not verify on its own, not a hole in the answer.

## The DENY trace

Same command, scoped this time to a single list:

```
sppa explain-access --site https://sp.contoso.local/sites/hr --user 'i:0#.w|contoso\rlee' --list Salaries
```

Output:

```
SharePoint access explanation
Site: https://sp.contoso.local/sites/hr
User: Rachel Lee (User, id 21)
Login: i:0#.w|contoso\rlee

Verdict: NO ACCESS

Inheritance is broken at:
  • web: Human Resources
  • list: Salaries

How access is granted:
  ? AD security group "CONTOSO\Payroll" (membership not verifiable via REST) — Contribute @ list "Salaries"
      AD security group — REST cannot expand its membership. The effective-permission result already accounts for it.

AD security groups on the ACL (not expanded):
  • CONTOSO\Payroll — Contribute @ Salaries

Notes:
  • Effective permissions are empty — the user has no access to this scope.
  • 1 AD security group(s) on this scope could not be expanded via REST. The effective-permission check above is still authoritative.
```

Rachel Lee is a contractor. She is a user in the site, but she is on none of the
role assignments on the `Salaries` list. `getUserEffectivePermissions` on that list
returns an empty mask, so the verdict is **NO ACCESS**.

The line to understand is `CONTOSO\Payroll`. That AD security group sits on the
`Salaries` ACL with Contribute. The tool cannot expand it over REST, so on its own
it cannot *prove* Rachel is not a member. It lists the group and marks it `?`
anyway — being explicit about what it checked and what it could not.

The Notes line "Effective permissions are empty — the user has no access to this
scope" is the resolution, and it is authoritative **even though the AD group can't
be expanded**. `getUserEffectivePermissions` runs on the server, where
`CONTOSO\Payroll` is fully resolved. If Rachel were in it, she would have a
Contribute mask on `Salaries` and the call would not have come back empty. An empty
result is proof she is in none of the principals on that ACL — `CONTOSO\Payroll`
included. The `?` is the tool showing its work, not hedging the verdict.

## Scanning the whole site collection

`explain-access` answers about one user. `scan-site` walks the web, every visible
list, and — unless you pass `--skip-items` — items with unique permissions, and
reports structural problems:

```
SharePoint permission scan
Site: Human Resources  https://sp.contoso.local/sites/hr

Summary
  • Lists scanned: 3
  • Lists with unique permissions: 1
  • Items with unique permissions: 1
  • Orphaned principals: 1
  • Broad-audience grants: 1
  • Oversized groups: 1
  • Site collection administrators: 1

Broken inheritance (3)
  • web Human Resources — 4 assignment(s): HR Owners, HR Members, Everyone, CONTOSO\HR-Admins
  • list Salaries — 3 assignment(s): HR Owners, S-1-5-21-1587823456-2044876312-3512441802-2571, CONTOSO\Payroll
  • item /sites/hr/Salaries/2024 Executive Compensation.xlsx — 1 assignment(s): Jane Doe

Orphaned principals (1)
  • [high] S-1-5-21-1587823456-2044876312-3512441802-2571 — Display name is an unresolved SID identical to the login SID.
      on ACL: Salaries

Broad-audience grants (1)
  • Everyone @ Human Resources — Read

Oversized groups (1)
  • All HR Staff — 112 members (owner: HR Service Account)

Site collection administrators (1)
  • Mark Adams i:0#.w|contoso\mark

Read-only scan. No data left this machine.
```

Each finding maps to a real clean-up task. The orphaned principal is a deleted AD
account still on the `Salaries` ACL, showing as a raw SID because SharePoint can no
longer resolve it. The broad-audience grant is the same `Everyone` claim you saw in
Jane's trace. The oversized group is one to review before a migration copies it
forward as-is. `--format json` emits a stable envelope (`schemaVersion: 1`) you can
diff between runs or feed into a report.

## Honest limits

The `v0.2.x` line does one job on classic NTLM farms. What it does not do:

- **NTLM with an explicit account only.** No AD FS / WS-Federation, no Forms-Based
  Auth, no Kerberos-only endpoints. Auth setup is in
  [docs/AUTH.md](https://github.com/a-kazemi/sppa/blob/main/docs/AUTH.md);
  failure modes are catalogued in
  [docs/TROUBLESHOOTING.md](https://github.com/a-kazemi/sppa/blob/main/docs/TROUBLESHOOTING.md).
- **No AD security-group expansion.** SharePoint REST does not expose it. The tool
  names the AD groups on each ACL, marks them `?`, and relies on
  `getUserEffectivePermissions` — which resolves them server-side — for the verdict.
- **Read-only.** `GET` requests to `_api`, nothing else. It will not fix anything it
  finds, and it sends nothing anywhere. No account required.
- **Single farm.** No multi-farm, no scheduled snapshots, no drift diffing.

## Links

- Repo: https://github.com/a-kazemi/sppa
- Worked example — the farm above, with verbatim tool output:
  https://github.com/a-kazemi/sppa/tree/main/sample
- Hit an auth failure or a verdict you can't explain? The issue forms are at
  https://github.com/a-kazemi/sppa/issues/new/choose — the
  *Authentication failure report* is the most useful one right now. There is also a
  *free permission audit* form: if you have a messy permission situation and want a
  second pair of eyes on the `explain-access` / `scan-site` output, open one (no
  data needed) and you'll get help reading it, no charge.
