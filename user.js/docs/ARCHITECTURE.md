# Architecture

## Style

Two different styles coexist:

- **CP and FP**: a route-guarded module-registry pattern — an array of module descriptors dispatched
  against page context. Each defines `const modules = [...]` (`peeringdb-cp-consolidated-tools.src.js:8970`,
  `peeringdb-fp-consolidated-tools.src.js:2124`) and a `dispatchModules(ctx)` function
  (`:10554` / `:3183`) that iterates it.
- **DeskPro**: direct feature functions wired to menu commands/DOM observers, via
  `registerDpMenuCommands()` (`peeringdb-deskpro-tools.src.js:3438`) — no module registry.

Constraints driving this: (1) Tampermonkey loads exactly one self-contained file per script — no
runtime `@require` of the shared lib, so it's textually inlined at build time; (2) each script must
not touch another's route (CP is `@exclude`d from FP's match; CP's header states "RDAP ownership is
CP-only; do not assume FP/DP parity", `peeringdb-cp-consolidated-tools.src.js:36`).

## Entry Points

No traditional `main()`/CLI entry point. Three effective entry points, one per script, each an IIFE
injected by Tampermonkey at `document-end` on a matching URL — selection is entirely via each
`.meta.js`/`.user.js` header's `@match`/`@exclude`/`@run-at` directives, no runtime router:

- `peeringdb-cp-consolidated-tools.user.js` — `@match https://www.peeringdb.com/cp/peeringdb_server/*/*/change/*` (+ beta host)
- `peeringdb-fp-consolidated-tools.user.js` — `@match https://www.peeringdb.com/*` (excludes `/cp/*`)
- `peeringdb-deskpro-tools.user.js` — `@match https://peeringdb.deskpro.com/app*`

## System Flow

```text
Tampermonkey injects .user.js at document-end on a matching URL
  -> IIFE runs, top-of-file constants/feature-flags/lib (dbg, fetchWithRetry, ...) initialize
  -> [CP/FP] route context built from window.location -> dispatchModules(ctx) checks
     disabled-modules list, module.match(ctx), module.preconditions(ctx) per module
     [DP] registerDpMenuCommands() + DOM mutation observers wire up feature functions directly
  -> matched module/feature attaches DOM listeners, injects UI (buttons/links/menu commands)
  -> user interaction triggers async work: fetchWithRetry (same-origin PeeringDB API) or
     gmRequestWithRetry (cross-origin RDAP/IX-F/psl)
  -> result renders in the page, copies to clipboard, or shows a GM_notification/console message
```

## Module Boundaries / Layer Responsibilities

| Layer or module | Owns | Must not own |
|-----------------|------|--------------|
| `lib/admincom-common.js` | Gated debug logging (`dbg`/`dbgInfo`/`dbgWarn`/`dbgGroup`/`dbgGroupEnd`), `isDebugEnabled()`/`toggleDebugMode()`, the retry/backoff request wrappers (`fetchWithRetry`, `gmRequestWithRetry`, `classifyRetry`) | Script-specific business logic, UI, or module registries |
| `lib/cp-name-normalization.js` | Pure org/RDAP name-normalization string transforms (`stripCompanyTypeSuffix`, `sanitizeRdapOrgName`, `parseOrganizationNameIdentity`, etc.), used by CP's RDAP fallback flow and name-sync modules | DOM/storage/network access, module-specific orchestration — see [CONCERNS.md](CONCERNS.md) "CP File-Split Progress" for the extraction plan this is part of |
| CP module registry (`modules` + `dispatchModules`) | Admin-workflow modules gated to CP changelist/change-page routes; owns the RDAP fallback client | FP/DP parity assumptions (explicitly disclaimed in-file) |
| FP module registry (`modules` + `dispatchModules`) | Frontend (Net/Org/Fac/IX/Carrier) admin-console conveniences | CP-page logic (`@exclude`d) |
| DeskPro feature functions | Ticket-page link/ASN enrichment, Whitelist CMD Generator, renumber-launcher handoff to CP | A module-registry abstraction (none exists here) |
| `*.src.js` | One script's own modules, route guards, and UI/business logic | Hand-duplicated copies of anything in the shared lib |
| `*.user.js` | Nothing — fully generated | Any hand-edit; overwritten by the next build (`GENERATED BLOCK` markers enforce this) |

## Reused Patterns

| Pattern | Where found | Why it exists |
|---------|-------------|----------------|
| Route-guarded module registry (`modules[]` + `match`/`preconditions` + `dispatchModules`) | CP, FP (`peeringdb-cp-consolidated-tools.src.js:8970`, `peeringdb-fp-consolidated-tools.src.js:2124`) | Lets many independent admin-workflow tweaks share one script without interfering, each individually toggleable via `disabledModules` |
| Per-module `try/catch` inside the dispatch loop | `dispatchModules` in CP and FP | Catches and logs errors to prevent cascade failures — one broken module can't take down the others |
| Self-refreshing `GM_registerMenuCommand` (unregister + re-register to update a label like "Debug Mode [ON]") | Debug-mode toggle in all three scripts; CP's "Log User-Agent" command | Tampermonkey menu labels are static once registered; this is the only way to reflect current state |
| Action lock (`tryBeginActionLock`/`endActionLock`) | CP (e.g. Recent IP Changes report, `peeringdb-cp-consolidated-tools.src.js:10516`) | Prevents a user from opening the same modal/action twice concurrently |
| `@ai Preserve ...` / `@ai Keep behavior stable ...` JSDoc annotations | Pervasive across all three `.src.js` (900+ occurrences repo-wide) | Behavior-contract markers — see [CONVENTIONS.md](CONVENTIONS.md) "Documentation convention" for what they mean and how to treat them |

## Known Architectural Risks

The two most consequential structural risks — CP's single-file scale and DeskPro's lack of a shared
module registry — are tracked with severity/impact/action detail in [CONCERNS.md](CONCERNS.md) "Top
Risks" rather than restated here. One risk not covered there:

- **No automated verification of architectural invariants** (e.g. "CP owns RDAP, FP doesn't") — these
  are documented only in code comments, not enforced by any test or lint rule (see
  [CONCERNS.md](CONCERNS.md) for the broader lack-of-CI risk).
