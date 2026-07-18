# Userscripts — agent notes

`peeringdb/admincom` (this repo) is a small collection of Tampermonkey/Greasemonkey userscripts that
add admin tooling to PeeringDB's Control Panel (CP) and Frontend (FP), plus DeskPro support-ticket
tooling (DP). There is no application server, package manager, or test suite — the entire codebase
lives right here in `user.js/`, and scripts run client-side in the browser once installed via
Tampermonkey.

## Layout

- `*.user.js` — **generated** distributable scripts, installed directly into Tampermonkey. Never
  hand-edit the `GENERATED BLOCK` inside these — edit the matching `.src.js` and regenerate; hand-edits
  are overwritten on the next build.
- `*.src.js` — editable sources for the three consolidated scripts (CP, FP, DeskPro).
- `lib/admincom-common.js` — shared fragment (gated debug logging + retry/backoff request wrapper)
  inlined into every `.user.js` by the build script.
- `scripts/build_userscripts.py` — regenerates `.user.js` from `.src.js` + the lib.
- `*.meta.js` — lightweight update-check manifests, one per script, hand-maintained (not generated).
- `README.md` — human-facing docs: installation, module catalog, feature-flag console recipes,
  User-Agent configuration reference, metadata/version convention.
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

There is no automated test suite (no CI workflow, no package.json, no test runner). Verification is:

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
  `peeringdb.com` origin) — saved user config depends on these.
- Adding a module to CP or FP? Give it a stable ID, gate it through the existing `disabledModules`
  pattern like its neighbors, and add the ID to README's Module ID catalog so it stays in sync.
- A function tagged `@ai Preserve ...` or `@ai Keep behavior stable and prefer minimal, localized
  edits.` encodes a contract something else depends on — read the annotation before refactoring past
  it.
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
  above, confirm `node --check` passes on any changed `.user.js`, and bump `@version` per the
  metadata convention.

## Additional notes

- Deliberately zero-dependency: Python stdlib for the build script, plain browser APIs (Tampermonkey
  `GM_*` grants, `fetch`, `localStorage`) for the scripts themselves. Don't introduce a package
  manager or bundler without discussing it first — it's a real architectural shift for this repo.
- Details: [README.md](README.md) — installation, the full module-ID catalog, feature-flag console
  recipes, and User-Agent configuration reference.
