# Roadmap

A consolidated, prioritised backlog for `sppa`. It exists so feature requests
have somewhere to land: the `v0.2.x` line is deliberately narrow and
[CONTRIBUTING.md](../CONTRIBUTING.md) declines unsolicited feature PRs. An item
appearing here means "we think this is worth doing eventually" — **not** that it
is accepted, scheduled, or that a PR for it will be merged. Open an issue and
make the case before writing code.

Ordering is by expected value per unit of work, not by how interesting the
feature is. Two rules constrain everything on this list:

- **Read-only, forever.** No item may issue anything but `GET`. Where an item
  looks like a write (remediation, simulation), it must *emit a script or a
  prediction* that a human reviews and runs — never act itself.
- **Zero runtime dependencies.** `package.json` `dependencies` stays empty.
  Anything needing a protocol client (LDAP, Kerberos) either uses a Node
  built-in, is vendored like `src/auth/ntlm.ts`, or is dropped.

---

## Already shipped

Recorded because they were repeatedly requested and are now done — do not
re-open them.

- [x] Standalone HTML report for `scan-site` (`0.2.0`)
- [x] Published to npm as `@a-kazemi/sppa` (`0.2.0`)
- [x] `list-access` — the "who has access here?" inverse of `explain-access` (`0.2.0`)
- [x] `scan-site --recurse` over subwebs (`0.2.0`)
- [x] `--concurrency <n>`, plus automatic throttle / transient-failure retry (`0.2.0`)
- [x] Stable JSON envelope with `schemaVersion` (`0.1.0`)

---

## Phase 1 — adoption blockers

Nothing here is a feature. Each is a reason somebody who wants the tool cannot
currently run it, so all of them outrank every feature below.

- [ ] **`--insecure`, and `--ca <file>` for the correct fix.** Internal farms
      routinely use self-signed or private-CA certificates; today that is a hard
      exit 5. The opt-out must be loud and never a default. *Cheapest item on
      the list, and a large share of "cannot run it at all".*
- [ ] **Current-user / integrated auth on Windows (SSPI, then Kerberos).** Many
      farms have NTLM disabled or Extended Protection on, and many admins cannot
      put a service password in the environment. Minimum viable version: use the
      logged-on user's credentials on Windows. Full Kerberos (SPNEGO ticket
      acquisition) is a much larger job — scope it separately. See
      [AUTH.md](AUTH.md) for what the current line supports.
- [ ] **Single-file Windows binary** (Node SEA or equivalent). SharePoint
      servers are locked down and frequently have no Node runtime; a `.exe`
      dropped on a jump box removes the install step entirely.
- [ ] **`sppa doctor --site ...`** — resolve DNS, check the TLS chain, `_api`
      reachability, each auth leg, clock skew, and print one verdict per check.
      Turns the [TROUBLESHOOTING.md](TROUBLESHOOTING.md) matrix into something
      the user runs instead of reads.

## Phase 2 — highest value per unit of work

- [ ] **CSV / NDJSON output** (`--format csv`, `--format ndjson`). The most
      requested output gap: admins want `list-access` and `scan-site` findings in
      Excel, SIEMs want one JSON object per line. Pure rendering on top of the
      existing envelope — no new SharePoint traffic.
- [ ] **Snapshot + diff.** `sppa diff old.json new.json` over the existing
      `schemaVersion: 1` envelope: access added or removed, inheritance newly
      broken, orphaned SIDs that are new. Nearly free given the envelope already
      exists, and it answers the question audit and compliance teams actually
      ask — *what changed this week?* Most comparable tools only snapshot.
- [ ] **CI mode: `--fail-on` plus a baseline file.** e.g.
      `--fail-on broken-inheritance,everyone,orphaned-sid` exits non-zero, while
      a committed baseline (YAML/JSON) declares which existing findings are
      accepted. This is what moves `sppa` from "I ran it once" to "it runs
      nightly in a pipeline". Needs a new exit code for *findings present*,
      distinct from the operational codes 2–5 in
      [the exit-code table](../README.md#exit-codes) — do not renumber those.
- [ ] **Severity classification and a summary risk score.** Tag each finding
      `critical` / `high` / `medium` / `low` (Everyone + Full Control and
      anonymous access are critical; broken inheritance is high; empty groups are
      low), add `--min-severity`, and print a short scorecard at the top of the
      terminal and HTML output. Makes the output legible to a manager, and is a
      prerequisite for `--fail-on` meaning anything.
- [ ] **Custom role definitions.** Report the role definition names actually
      present on a scope, not just the built-in ladder
      (`Read` / `Contribute` / `Edit` / …). Farms with bespoke permission levels
      currently read as misleadingly familiar.
- [ ] **Full inheritance chain in `explain-access`.** Show the whole
      site → web → list → item path with each hop marked inherited or unique,
      rather than only the point where inheritance breaks.

## Phase 3 — scale and reach

- [ ] **Reverse `explain-access`: "what can this user reach?"** Given a user,
      enumerate every site / list / item they can access. This is the first
      question asked at offboarding and during an incident. Expensive to answer
      honestly — it is a crawl, not a lookup — so it needs `--max-*` bounds and a
      clear statement of what it did *not* examine.
- [ ] **`who-can-access <url>`** for a single document or folder: direct grants,
      group paths, nested groups.
- [ ] **Multi-site / farm-level scanning.** Take a list of site collections (a
      file, or enumerated from a web application), scan them with bounded
      concurrency, emit one aggregated report. Being limited to a single site
      collection is the current ceiling on usefulness.
- [ ] **Optional AD group expansion over LDAP** (`--ldap`, off by default). The
      one item that turns "this AD group cannot be expanded" from a permanent
      caveat into an answer, and the only way to get it — SharePoint REST does
      not expose membership. Constrained by the zero-dependency rule: it needs a
      vendored, minimal, read-only LDAP client, which is a real project on its
      own. Verdicts stay based on `getUserEffectivePermissions`; LDAP only fills
      in the *why*.
- [ ] **Group analysis.** Nested-group topology, principals with more than one
      path to Full Control, empty groups, groups nothing has been granted to.
- [ ] **Response cache / resumable scans.** Persist raw `_api` responses so a
      large interrupted scan resumes and a report can be re-rendered offline.
      Partly exists via `scripts/scan-report.mjs`; this generalises it.

## Phase 4 — ergonomics and integration

- [ ] **Config file** (`sppa.json` / `sppa.yml`): site lists, thresholds, exclude
      patterns, baseline path. Credentials stay in the environment — never in the
      config file.
- [ ] **Progress reporting for long scans**, and `--estimate` / dry-run that
      reports how many requests a scan will cost before issuing any.
- [ ] **`--no-color` and `NO_COLOR` support**, with a TTY-detection review in
      `src/util/ansi.ts`.
- [ ] **Expose the core as a library**, not only a CLI. `src/analysis/` is
      already pure functions, so this is mostly an entry point plus an API
      commitment — do it once the shape has stopped moving.
- [ ] **Markdown report output**, alongside terminal / JSON / CSV / HTML.

## Phase 5 — differentiators (unscheduled)

Worth keeping, none of it justified yet. Listed so it is not lost.

- [ ] **Remediation script generation.** Emit PowerShell for a human to review —
      removing orphaned SIDs, say — without ever running it. Closes the gap
      between "found the problem" and "fixed it" while keeping the read-only
      guarantee intact.
- [ ] **Permission path graph** exported as Mermaid / DOT / JSON:
      user → group → nested group → permission level on a scope.
- [ ] **Simulation.** "If I add this user to that group, what changes?" and "if I
      remove them, what do they lose?" — a prediction computed from already
      scanned data, not a write.
- [ ] **Historical tracking.** Store snapshots locally (SQLite, or a plain JSON
      directory) and trend findings over time. Folds in the diff work above.
- [ ] **Scheduled monitoring** (`sppa monitor`): scan, diff against the previous
      snapshot, notify. Largely orchestration once diff and baselines exist — a
      scheduled task calling the CI mode may well be enough.
- [ ] **Local report browser** (`sppa serve`) for reading reports without a
      terminal.
- [ ] **SharePoint Online / Graph support.** Deliberately last. On-premises is
      this tool's niche precisely because everything new targets SPO; widening
      the scope dilutes that and doubles the auth surface.
