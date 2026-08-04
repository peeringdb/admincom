# Userscripts — agent notes

`peeringdb/admincom` (this repo) is a small collection of Tampermonkey/Greasemonkey userscripts that
add admin tooling to PeeringDB's Control Panel (CP) and Frontend (FP), plus DeskPro support-ticket
tooling (DP). There is no application server or package manager — the entire codebase lives right
here in `user.js/`, and scripts run client-side in the browser once installed via Tampermonkey. A
`node:test` suite exists under `user.js/tests/` and a GitHub Actions workflow runs it (plus the
build/syntax checks) on every push and PR (see "Testing" below) — but it covers a meaningful
minority of the codebase; manual browser smoke testing is still the primary verification method for
most modules.

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
- `.github/ISSUE_TEMPLATE/` (repo root) — issue templates for admin add/remove requests.
- `.github/workflows/verify.yml` (repo root) — CI: `build_userscripts.py --check`, `node --check` on
  every generated `.user.js`, and `node --test`, on every push/PR. Does not run the opt-in live suite
  (`user.js/tests/live/`) — see Testing below.

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

There is no package.json (deliberately zero-dependency — see "Additional notes" below), but there is
CI: `.github/workflows/verify.yml` runs the build-check, syntax-check, and full `node --test` suite
on every push/PR (not the opt-in live suite — see below). There is a behavioral test suite for all
three scripts under `user.js/tests/`, using Node's built-in test runner (`node:test`/`node:assert`,
no new dependency beyond Node itself, which is already required for `node --check`). It currently covers:
- the `set-window-title` module's title format for every page kind in CP and FP;
- DP's org-link-shortcut behavior (`ensureOrgShortcut`/`hydrateExistingPeeringDbAnchor` — every
  entity kind gets the owning org's link inserted beside it, not just shown in the tooltip);
- the unified cross-script API-entity cache (`shared-cache.test.js` — CP and FP genuinely share
  cached org/entity data via `getCachedDataFromStorage`/`setCachedDataInStorage` in
  `lib/admincom-common.js`, both same-origin on `peeringdb.com`; simulated by pointing two separate
  `loadScript()` calls at the same fake `localStorage` instance — DP is deliberately excluded since
  it runs on a different origin and can never share with CP/FP regardless of code);
- CP's org/RDAP name-normalization helpers (`cp-name-normalization.test.js` — the highest
  regex-complexity, highest silent-regression-risk surface in the repo: 150+ legal-suffix patterns
  across dozens of jurisdictions in `lib/cp-name-normalization.js`). Two tests in there are marked
  "known discrepancy" — they lock in current (not necessarily correct) behavior for cases where the
  code doesn't do what its own docstring claims; see the test file for specifics before "fixing"
  either without reading why;
- the shared retry/backoff decision logic (`admincom-common-retry.test.js` —
  `parseRetryAfterMs`/`classifyRetry`, used by every GM_xmlhttpRequest/fetch call in all three
  scripts);
- DP's Whitelist CMD Generator URL/hostname parsing (`dp-whitelist-generator.test.js` —
  `parseWhitelistChangeHref`/`extractWhitelistHostname`; `deriveWhitelistCandidates`'
  PSL-based eTLD+1 resolution is *not* covered, since the PSL library is loaded via `@require` and
  isn't available in this offline test environment);
- CP's IP/CIDR host-bit arithmetic (`cp-ip-cidr.test.js` — `parseIp`/`formatIp`/`parseCidr`/
  `replaceHostInPrefix`, the BigInt math behind the IXLAN Renumber modal; a silent regression here
  misconfigures live peering sessions, making it the single highest-consequence untested surface
  identified in the repo);
- CP's renumber classification (`cp-renumber-classification.test.js` — `parseRenumberHash` (the
  hash-payload contract with the DP launcher), `classifyRenumberRows` (per-row eligible/conflict/
  skip/no-change classification), `buildNetixlanPutPayload`, and `extractRenumberApiErrorDetail`);
- CP's IX-F Member Audit and Conflict Resolver safety logic (`cp-ixf-merge-gates.test.js` —
  `extractIxfAsnIpPairs`/`findIxfMergeCandidates` for both the "split" and "stale-dual" merge
  shapes, and `buildMergePlan`/`verifyConflictGates`, the 8-gate check that must all pass before an
  operator DELETEs a live netixlan row; several cases lock in the exact operator-discovered
  edge cases referenced in the source comments, e.g. ixlan #3990/AS211750);
- CP's Network Name Pattern Diagnostics and Recent IP Changes audit reconciliation
  (`cp-name-pattern-diagnostics.test.js` — `classifyNetworkNamePattern`, the dense multi-signal
  regex scoring function deciding which network names look auto-generated/handle-like;
  `buildNetworkNamePatternSummary`/`buildSuspiciousNetworkNameTsv` for the scan's notification and
  TSV-export formatting; `mergeAuditSources`/`formatRecentChangeLines` for reconciling API rows with
  local audit-log entries into the operator-facing diff lines);
- DP's text-linkification engine (`dp-linkify-text.test.js` — `linkifyText`'s `REPLACEMENT_RULES`
  (4 overlapping ASN/org-name regex patterns run in one combined, position-sorted pass) and
  `findProbableStandaloneAsnHits`, a heuristic detector for bare 3-10 digit ASN lines gated on
  surrounding context to avoid false-positiving on arbitrary numbers — the richest untested
  regex/business logic in either script);
- DP's IXLAN Peer Renumber launcher and Whitelist CMD Generator command builder
  (`dp-renumber-launcher.test.js` — `collectRenumberCandidates`/`extractIxlanIdFromTicket` (ticket-
  text parsing distinct from CP's renumber classification), `buildRenumberCpUrl` (the DP→CP hash-
  payload contract), and `buildWhitelistCommand`);
- DP's CP-fallback-on-404 flow, mailto decoration, and shared error classifier
  (`dp-cp-fallback-and-mailto.test.js` — `getCpModelForFrontendKind`/`buildCpChangeUrl`/
  `getFrontendExistenceProbeUrl`/`isFrontendEntityMissing` (the last exercised via the fetchMap
  mock, both the "exists" and "404" paths), `extractMailtoAddress`/`buildCpEmailSearchUrl`, and
  `classifyError`, the retry/abort decision classifier used across DP's API calls).

These are the highest-regression-risk surfaces, since the strings/DOM output are asserted verbatim.
It does **not** cover every module in every script (CP alone has ~207 top-level helper functions);
most still rely on manual smoke testing. Remaining high-value pure-logic targets (FP's admin-ops
URL builders and a handful of shared cache-helper edge cases) are tracked in `docs/CONCERNS.md`'s
Top Risks row for test coverage — extend the relevant `window.__pdbXxTestHooks__` object and follow
the pattern of the test files above rather than waiting on a `lib/*.js` extraction first.

- `node --test` (run from `user.js/`) — runs the full suite; auto-discovers `tests/**/*.test.js`.
- `user.js/tests/helpers/browser-shim.js` — hand-rolled fake `window`/`document` (no jsdom): loads
  a generated `.user.js` into a `node:vm` context and reads exposed functions off
  `window.__pdbFpTestHooks__` / `window.__pdbCpTestHooks__` / `window.__pdbDpTestHooks__`. Those
  hooks only exist when `window.__PDB_TEST__` is set on the sandbox before eval (see the bottom of
  each `.src.js`) — this skips the real browser bootstrap (MutationObserver/requestAnimationFrame/
  GM_* calls/menu registration) that a minimal test DOM can't support, and is never set by
  Tampermonkey, so production behavior is unchanged. The shim also provides a minimal
  `document.createElement`-capable `FakeElement` (supports `insertAdjacentElement`/`append`/
  attributes — enough to test code that creates and inserts DOM nodes, e.g. DP's org shortcut),
  `document.createTextNode`/`document.createDocumentFragment` (`FakeTextNode`/
  `FakeDocumentFragment`, the latter just `FakeElement` under a non-tag name — enough to test code
  that builds a fragment of mixed text/element children, e.g. DP's `linkifyText`), an
  optional `fetchMap` (exact request URL → JSON body) that backs a fake `fetch()` so API-calling
  functions run for real against canned data with zero live network access, and an optional
  `localStorage` override (`makeFakeStorage()`, exported) so two separate `loadScript()` calls can be
  pointed at the *same* fake storage instance to simulate two same-origin scripts sharing real
  browser storage (used to test CP/FP cache sharing). Tests run against the generated `.user.js` (the
  artifact users actually install), so regenerate before running tests if you've edited a `.src.js`.
- `user.js/tests/helpers/pure-lib-loader.js` — for `lib/*.js` fragments with zero window/document/
  fetch/GM_* references (e.g. `lib/cp-name-normalization.js`, or the retry/backoff half of
  `lib/admincom-common.js`): no vm sandbox needed, just `new Function(source + return {...names})` to
  get real references to the requested top-level functions/consts. Simpler and faster than
  `browser-shim.js` for pure string/regex-transform code; don't reach for it if the fragment touches
  the DOM or browser globals.
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
- CI (`.github/workflows/verify.yml`) enforces the build-check, syntax-check, and `node --test` on
  every push/PR — but run them locally first rather than relying on CI to catch it. Before opening a
  PR: run the regenerate + `--check` commands above, confirm `node --check` passes on any changed
  `.user.js`, run `node --test` from `user.js/` (add/update cases under `user.js/tests/` if you
  touched code covered there, or want similar coverage for something newly-touched), and bump
  `@version` per the metadata convention.

## Additional notes

- Deliberately zero-dependency: Python stdlib for the build script, plain browser APIs (Tampermonkey
  `GM_*` grants, `fetch`, `localStorage`) for the scripts themselves. Don't introduce a package
  manager or bundler without discussing it first — it's a real architectural shift for this repo.
- Details: [README.md](README.md) — installation, the full module-ID catalog, feature-flag console
  recipes, and User-Agent configuration reference.
