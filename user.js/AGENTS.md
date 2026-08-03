# Userscripts — agent notes

`peeringdb/admincom` (this repo) is a small collection of Tampermonkey/Greasemonkey userscripts that
add admin tooling to PeeringDB's Control Panel (CP) and Frontend (FP), plus DeskPro support-ticket
tooling (DP). There is no application server or package manager — the entire codebase lives right
here in `user.js/`, and scripts run client-side in the browser once installed via Tampermonkey. A
small `node:test` suite exists under `user.js/tests/` (see "Testing" below) but is not a
traditional CI-gated test suite — manual browser smoke testing is still the primary verification
method for most modules.

## Layout

- `*.user.js` — **generated** distributable scripts, installed directly into Tampermonkey (see "Rules
  when editing a script here" below before touching one).
- `*.src.js` — editable sources for the three consolidated scripts (CP, FP, DeskPro).
- `lib/admincom-common.js` — shared fragment (gated debug logging + retry/backoff request wrapper)
  inlined into every `.user.js` by the build script.
- `scripts/build_userscripts.py` — regenerates `.user.js` from `.src.js` + the lib.
- `*.meta.js` — lightweight update-check manifests, one per script, hand-maintained (not generated).
- `README.md` — human-facing docs: installation, module catalog, feature-flag console recipes,
  User-Agent configuration reference, metadata/version convention.
- `docs/` — deeper codebase docs: [ARCHITECTURE.md](docs/ARCHITECTURE.md) (module-registry pattern,
  system flow, layer boundaries), [CONCERNS.md](docs/CONCERNS.md) (known risks/debt/security gaps),
  [INTEGRATIONS.md](docs/INTEGRATIONS.md) (external systems, retry/reliability behavior),
  [CONVENTIONS.md](docs/CONVENTIONS.md) (naming, logging, error handling).
- `.github/ISSUE_TEMPLATE/` (repo root) — issue templates for admin add/remove requests. No CI
  workflows exist in this repo.

## Setup

No install step. Python 3 (stdlib only, no external dependencies) is needed to run the build script:

```console
python user.js/scripts/build_userscripts.py          # regenerate all .user.js from .src.js + lib
python user.js/scripts/build_userscripts.py --check   # verify generated files are up to date, no writes
```

Run these from the repo root (the script resolves `user.js/` as a relative path).

## Development workflow

1. Edit a script's `.src.js` (or `lib/admincom-common.js` for logic shared across all three scripts).
2. Regenerate: `python user.js/scripts/build_userscripts.py`.
3. Verify: `python user.js/scripts/build_userscripts.py --check` should report everything up to date.
4. Bump `@version` — see "Rules when editing a script" below.
5. Manually verify in a real browser — see Testing below.

## Testing

There is no CI workflow and no package.json (deliberately zero-dependency — see "Additional notes"
below). There is a small behavioral test suite for all three scripts under `user.js/tests/`, using
Node's built-in test runner (`node:test`/`node:assert`, no new dependency beyond Node itself, which
is already required for `node --check`). It currently covers: the `set-window-title` module's title
format for every page kind in CP and FP, and DP's org-link-shortcut behavior (`ensureOrgShortcut` /
`hydrateExistingPeeringDbAnchor` — every entity kind now gets the owning org's link inserted beside
it, not just shown in the tooltip). These are the highest-regression-risk surfaces, since the
strings/DOM output are asserted verbatim. It does **not** cover every module in every script; most
still rely on manual smoke testing.

- `node --test` (run from `user.js/`) — runs the full suite; auto-discovers `tests/**/*.test.js`.
- `user.js/tests/helpers/browser-shim.js` — hand-rolled fake `window`/`document` (no jsdom): loads
  a generated `.user.js` into a `node:vm` context and reads exposed functions off
  `window.__pdbFpTestHooks__` / `window.__pdbCpTestHooks__` / `window.__pdbDpTestHooks__`. Those
  hooks only exist when `window.__PDB_TEST__` is set on the sandbox before eval (see the bottom of
  each `.src.js`) — this skips the real browser bootstrap (MutationObserver/requestAnimationFrame/
  GM_* calls/menu registration) that a minimal test DOM can't support, and is never set by
  Tampermonkey, so production behavior is unchanged. The shim also provides a minimal
  `document.createElement`-capable `FakeElement` (supports `insertAdjacentElement`/`append`/
  attributes — enough to test code that creates and inserts DOM nodes, e.g. DP's org shortcut) and
  an optional `fetchMap` (exact request URL → JSON body) that backs a fake `fetch()`, so
  API-calling functions run for real against canned data with zero live network access. Tests run
  against the generated `.user.js` (the artifact users actually install), so regenerate before
  running tests if you've edited a `.src.js`.
- `user.js/tests/live/` — opt-in, network-touching hardening tests (currently just FP entity-page
  titles) that fetch a handful of real records from the public PeeringDB API and check the title
  format against real field values/shapes, not just synthetic fixtures. **Not** part of the default
  `node --test` run — skipped unless `PDB_LIVE_TESTS=1` is set — because PeeringDB's public API is
  rate-limited to 20 requests/minute for anonymous callers and a network dependency doesn't belong
  in the suite that runs on every edit. Run explicitly with
  `PDB_LIVE_TESTS=1 node --test tests/live/*.test.js` (from `user.js/`); each file in there makes at
  most a handful of spaced-out requests — re-check that budget before adding more calls, and never
  loop it or wire it into CI on every push.
- `node --check user.js/*.user.js` — syntax sanity check only; catches parse errors, not behavior.
- `python user.js/scripts/build_userscripts.py --check` — confirms generated output matches source.
- Manual smoke test: install the regenerated `.user.js` in Tampermonkey and exercise the affected
  flow on the real page (`peeringdb.com/cp/...` for CP, `peeringdb.com/*` for FP,
  `peeringdb.deskpro.com/app*` for DeskPro).

## Rules when editing a script here

- Don't hand-edit the `GENERATED BLOCK` inside any `.user.js` — edit the `.src.js` or the lib and
  regenerate.
- Bump `@version` in both the `.src.js` header and the matching `.meta.js`, format
  `major.minor.bugfix` (see README's Metadata convention — if a script still carries an old
  `.YYYYMMDD` 4th segment, bump the bugfix number rather than dropping the date, or Tampermonkey will
  read it as a downgrade). Don't touch `@updateURL`/`@downloadURL`/`@supportURL`.
- Don't rename the `pdbCpConsolidated.*` / `pdbFpConsolidated.*` storage-key namespaces or the shared
  `pdbAdmincom.debug` flag (CP + FP intentionally share that one key since both run on the
  `peeringdb.com` origin) — saved user config depends on these. General naming pattern:
  [docs/CONVENTIONS.md](docs/CONVENTIONS.md) "Naming Rules".
- Adding a module to CP or FP? Give it a stable ID, gate it through the existing `disabledModules`
  pattern like its neighbors, and add the ID to README's Module ID catalog so it stays in sync.
- A function tagged `@ai Preserve ...` or `@ai Keep behavior stable and prefer minimal, localized
  edits.` encodes a contract something else depends on — read the annotation before refactoring past
  it. Full convention: [docs/CONVENTIONS.md](docs/CONVENTIONS.md) "Documentation convention".
- A script listed under README's "Legacy scripts" section is a deprecation stub — don't add real
  logic to it, point users at the consolidated replacement instead.

## Build and deployment

There's no build/deploy pipeline beyond the regenerate step above. Tampermonkey installs pull
`.user.js` directly from `raw.githubusercontent.com` via each script's `.meta.js`
`@updateURL`/`@downloadURL` (base path
`https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/`). Merging to `master`
effectively deploys — Tampermonkey auto-updates by polling the `.meta.js` on that branch.

## Commit / PR guidelines

- Commit messages follow Conventional Commits: `type(scope): description` — observed types are
  `feat`, `fix`, `chore`; observed scopes are `cp`, `fp`, `dp` and `deskpro` (used interchangeably for
  the DeskPro script — prefer `dp` for new commits to converge), `git`, `root`. Check
  `git log --oneline` for recent examples before picking a scope.
- No enforced CI checks exist today. Before opening a PR: run the regenerate + `--check` commands
  above, confirm `node --check` passes on any changed `.user.js`, run `node --test` from `user.js/`
  (add/update cases under `user.js/tests/` if you touched `set-window-title` or want similar
  coverage for another module), and bump `@version` per the metadata convention.

## Additional notes

- Deliberately zero-dependency: Python stdlib for the build script, plain browser APIs (Tampermonkey
  `GM_*` grants, `fetch`, `localStorage`) for the scripts themselves. Don't introduce a package
  manager or bundler without discussing it first — it's a real architectural shift for this repo.
- Details: [README.md](README.md) — installation, the full module-ID catalog, feature-flag console
  recipes, and User-Agent configuration reference.
