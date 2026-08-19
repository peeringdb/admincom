# Known Concerns

## Top Risks (Prioritized)

| Severity | Concern | Impact | Suggested action |
|----------|---------|--------|-------------------|
| Low | CI now runs `build_userscripts.py --check` + `node --check` + `node --test` on every push/PR (`.github/workflows/verify.yml`), and the `node:test` suite covers every pure-logic target identified across a 5-phase coverage-expansion pass (title-setting, DP org-link-shortcut/linkify-engine/renumber-launcher/CP-fallback/mailto, the shared cache including its negative-cache helpers, CP's name-normalization/IP-CIDR/renumber/IX-F-merge-gate/name-pattern-diagnostics logic, retry/backoff, DP's whitelist-URL parsing, FP's admin-ops URL/report builders — see [AGENTS.md](../AGENTS.md) Testing) | A regression in an untested module (most of CP's ~207 helper functions, most of FP/DP's DOM-touching modules) can still ship unnoticed until an admin hits it live | This pass is complete: every function flagged as a high-risk pure-logic target is covered. Remaining gaps are DOM-heavy modules already exercised by manual smoke testing (e.g. `fix-double-slashes`/`asn-404-cp-search-redirect`'s inline `window.location`-mutating closures, most toolbar/badge/highlight modules) — expand further only opportunistically, when touching a module for another reason, not as a standalone effort |
| Medium | CP script is a single ~479KB / ~11,600-line file with no internal module boundaries beyond the `modules[]` registry — a phased extraction into `lib/` fragments is underway, see below | High cognitive cost for any change; harder for both humans and AI agents to safely scope an edit | In progress: extract self-contained function clusters into `lib/cp-*.js` fragments, verified by diffing generated `.user.js` output before/after each extraction |
| Low | DeskPro doesn't share CP/FP's module-registry pattern (see [ARCHITECTURE.md](ARCHITECTURE.md)) | Anyone adding a route-guarded DeskPro feature can't reuse the `disabledModules` convention CP/FP users already know | May be intentional given DeskPro's single-page nature rather than debt — worth a deliberate call before converging it onto `modules[]` |
| Low | DeskPro's `@require` of `cdnjs.cloudflare.com/.../psl.min.js` has no Subresource Integrity (SRI) hash — see Security Concerns below | A CDN compromise could silently serve modified JS into DeskPro's DOM context | Vendor the pinned PSL version instead of loading it from a CDN at runtime (Tampermonkey's `@require` doesn't support SRI directly) |

## Technical Debt

| Debt item | Where | Risk if ignored | Suggested fix |
|-----------|-------|------------------|----------------|
| `.meta.js` commit-scope inconsistency (`dp` vs `deskpro`) | `git log --oneline` shows both `feat(dp): ...` and `fix(deskpro): ...` | Minor — cosmetic, makes `git log` scope-filtering slightly noisier | Prefer `dp` going forward (already documented in [AGENTS.md](../AGENTS.md)); no urgent fix needed |
| ~~No CI-enforced build-freshness check~~ Resolved | `.github/workflows/verify.yml` runs `build_userscripts.py --check` on every push/PR | N/A | N/A |

## Security Concerns

| Risk | OWASP category | Evidence | Current mitigation | Gap |
|------|-----------------|----------|---------------------|-----|
| `@connect *` wildcard cross-origin grant on CP and FP | A05 (Security Misconfiguration) | `peeringdb-cp-consolidated-tools.meta.js` `@connect *`; `peeringdb-fp-consolidated-tools.meta.js` `@connect *` (added with the `netixlan-ixf-verify` module) | Justified in-file: IX-F member-export hosts are operator-defined and can't be enumerated in advance; CP's request is `anonymous: true` GET-only, FP's fetch is read-only too (the resulting PUT/DELETE writes are same-origin, not cross-origin) | No allowlist restriction possible while supporting arbitrary IX portals — accepted tradeoff, not an oversight |
| Unpinned-by-integrity third-party CDN script (`@require` psl.min.js) — full risk framing in Top Risks above | A08 (Software and Data Integrity Failures) | `peeringdb-deskpro-tools.src.js:14` | Version is pinned in the URL (`1.12.0`) | No SRI/hash verification |
| No secrets/tokens stored anywhere | N/A | Repo-wide grep: zero `GM_getValue`/`GM_setValue` usage | Same-origin session-cookie auth only | None identified |

## Performance and Scaling

- No sequential-calls-that-could-parallelize pattern exists — `fetchWithRetry`/`gmRequestWithRetry`
  calls are triggered by discrete user actions, not batch loops.
- No in-memory caching pattern beyond `localStorage`-backed TTL caches (e.g. CP's
  organization-name/RDAP caches) — these are single-browser-tab scoped by nature (userscripts have no
  multi-instance concern), so the usual "in-memory cache in a multi-instance deployment" anti-pattern
  doesn't apply here.
- A full performance audit of CP's ~11,600-line file hasn't been done — flagging file size (Top Risks)
  is as far as this goes without deeper profiling.

## Fragile / High-Churn Areas

| Area | Why fragile | Safe change strategy |
|------|-------------|------------------------|
| `peeringdb-cp-consolidated-tools.user.js` | Largest file (~490KB), most integrations (RDAP, IX-F, PeeringDB API), most modules; highest churn in the repo | Edit `.src.js`, never the generated file; keep changes scoped to one module at a time per the existing `modules[]` boundaries; run `--check` + `node --check` before every commit |
| `peeringdb-deskpro-tools.user.js` / `.meta.js` | Second-highest churn; version-bump-heavy | Same discipline as CP; also confirm the DeskPro-specific proactive rate-limit throttling isn't broken by future retry-logic changes |
| `peeringdb-cp-consolidated-tools.meta.js` | Frequent version-only churn | Low actual risk — mostly `@version` bumps, not logic changes. `build_userscripts.py` now fails if the `.src.js` and `.meta.js` `@version` values disagree, so the pair can no longer drift silently; the format itself (`major.minor.bugfix`, [README.md](../README.md)) is still a human check |

## CP File-Split Progress

Contrary to this doc's earlier assumption, CP's ~207 top-level helper functions have no section
banners and aren't split along module IDs — "IX-F Member Audit" and "Conflict Resolver" turned out to
share core merge/gate logic with the IXLAN Renumber and Recent IP Changes modules, so they move as one
unit, not two. Extraction proceeds in independently-verified phases (each regenerated `.user.js` is
diffed against the pre-change version to confirm only the `GENERATED` banner text differs, i.e. zero
behavior change):

| Phase | Fragment | Lines | Status |
|-------|----------|-------|--------|
| 1 | `lib/cp-name-normalization.js` — org/RDAP name-normalization helpers (pure string transforms) | ~750 | Done |
| 2 | `lib/cp-toolbar-ui.js` — toolbar/DOM-builder UI kit | ~500 | Pending |
| 3 | `lib/cp-netixlan-reconciliation.js` — IXLAN renumber + IX-F audit + conflict-resolve + recent-ip-changes (one cohesive subsystem) | ~2,650 | Pending |
| 4 | `lib/cp-network-name-scan.js` — network-name-scan/pattern-diagnostics | ~700 | Pending, optional |

Each extraction shifts every line number below the removed block — Phase 1 alone already
invalidated several `peeringdb-cp-consolidated-tools.src.js:<line>` citations in
[ARCHITECTURE.md](ARCHITECTURE.md), [CONVENTIONS.md](CONVENTIONS.md), and
[INTEGRATIONS.md](INTEGRATIONS.md) (fixed once, but the mechanism will repeat). Treat a
docs line-number refresh as part of each remaining phase's own PR, not a separate cleanup
pass — grep the CP citations in those three files against the anchor text they describe
and correct any that drifted.
