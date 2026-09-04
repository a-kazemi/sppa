# Contributing

Thanks for looking. This is a small, deliberately narrow tool and the bar for
what it does is "one job, done well, on classic NTLM farms."

## What is welcome

- **Bug fixes** — especially anything the tool gets wrong on a real farm.
- **Authentication reports.** The NTLM handshake is the least-proven part of the
  code. A good report against a farm we cannot reach is worth more than a patch.
  Use the *Authentication failure report* issue template.
- **Documentation** — clearer `docs/`, more entries in
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md), fixes to the README.
- **Tests** — more recorded `_api` fixtures in [`sample/api/`](sample/api/),
  more MS-NLMP vectors, edge cases in the analysis layer.
- **CI / packaging** fixes.

## What will be declined right now

The current line is **feature-frozen**. The following are out of scope until
there is named, post-launch demand for them — please open an issue to make the
case rather than sending a PR. Most of them are queued and prioritised in
[`docs/ROADMAP.md`](docs/ROADMAP.md), which is where a request lands once the
case has been made; being listed there is still not an invitation to send the
patch unprompted:

- New flags, commands, or output formats (`--replay`, CSV, `diff`, etc.).
- New auth modes — Kerberos-only, AD FS / WS-Federation, Forms-Based Auth.
- AD security-group expansion (SharePoint REST does not expose membership;
  the verdict already relies on `getUserEffectivePermissions`, which resolves
  it server-side).
- Multi-farm, scheduled snapshots, drift diffing.
- Any write path. The tool issues `GET` only, by design, forever.
- Any runtime dependency. `package.json` `dependencies` stays empty; the NTLM
  and MD4 code is vendored on purpose.

## Development

```bash
npm install
npm run build
npm test          # builds, then runs the node:test suite
```

No live SharePoint farm is needed. `src/analysis/` and `src/auth/` are pure
functions tested against recorded REST fixtures and the MS-NLMP spec vectors.
`test/sample.test.ts` runs the whole `_api` → parse → analyse → render pipeline
against the synthetic farm in [`sample/`](sample/).

If you intentionally change analysis or rendering output, regenerate the
committed worked example so the drift check passes:

```bash
UPDATE_SAMPLES=1 npm run test:only
```

and review the `sample/` diff as part of your change.

## Pull requests

- Keep them focused; one concern per PR.
- Update `CHANGELOG.md` under `[Unreleased]` for anything user-visible.
- The PR template checklist is the merge bar.

## Reporting security issues

Do not open a public issue. Use the repository's private security advisory form
(`Security` → `Report a vulnerability`). See [`docs/SECURITY.md`](docs/SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the MIT
license in [`LICENSE`](LICENSE).
