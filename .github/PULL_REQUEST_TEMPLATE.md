<!--
v0.2.x is feature-frozen (see CONTRIBUTING.md). Bug fixes, docs, tests, and
CI changes are welcome. New flags/commands/output formats and new auth modes
will be declined until there is named post-launch demand — please open an
issue first so the change is not wasted work.
-->

## What this changes

<!-- One or two sentences. Link the issue it fixes. -->

## Why

## Checklist

- [ ] `npm test` passes locally
- [ ] No new runtime dependencies (`package.json` `dependencies` stays empty)
- [ ] Only `GET` requests are issued — no write path introduced
- [ ] `CHANGELOG.md` updated under `[Unreleased]` if user-visible
- [ ] `sample/` regenerated (`UPDATE_SAMPLES=1 npm run test:only`) if output changed
