# Coding Conventions

## Naming Rules

| Item | Rule | Example |
|------|------|---------|
| Files | kebab-case, `<name>.{meta,src,user}.js` triad | `peeringdb-cp-consolidated-tools.src.js` |
| Functions/methods | camelCase, verb-first | `dispatchModules`, `notifyUser`, `tryBeginActionLock` |
| Constants | SCREAMING_SNAKE_CASE | `MODULE_PREFIX`, `FEATURE_FLAGS_STORAGE_KEY`, `RETRYABLE_STATUS` |
| Storage keys (localStorage/sessionStorage) | dot-namespaced, `${MODULE_PREFIX}.<setting>`, except a few deliberately shared cross-script keys | `pdbCpConsolidated.disabledModules`, shared `pdbAdmincom.debug` / `pdbAdmincom.userAgent` — see [README.md](../README.md) |

No classes are used anywhere in the codebase (no `class ` declarations in any `.src.js`) — the
codebase is entirely closures/plain functions inside a top-level IIFE per script, so there's no
private-field-prefix convention to document.

## Formatting and Linting

No formatter or linter is configured. Most relevant *de facto* rules (observed, not enforced by
tooling): 2-space indentation, double-quoted strings, trailing commas in multiline literals,
`"use strict";` as the first statement inside every IIFE. Don't introduce a package manager or
bundler/linter without discussing it first (see [AGENTS.md](../AGENTS.md) "Additional notes").

## Import and Module Conventions

- No ES module `import`/`export` anywhere — each `.user.js` is one flat IIFE
  (`(function () { "use strict"; ... })();`).
- Code sharing across scripts happens at build time, not runtime: `scripts/build_userscripts.py`
  textually inlines `lib/admincom-common.js` at an `/* @include admincom-common.js */` marker in
  each `.src.js`, wrapped in a `// >>> GENERATED ... <<<` banner in the output `.user.js`.
- No barrel files, no path aliases — flat single-file scripts, nothing to alias.

## Error and Logging Conventions

- **Error strategy**: `try/catch` at the point where user-triggered async work can fail (e.g. inside
  a module's click handler, or per-module inside `dispatchModules`'s loop so one module's exception
  can't stop the others — `peeringdb-cp-consolidated-tools.src.js:10559`). Caught errors are logged
  via `console.error` and typically surfaced to the user via a `notifyUser({title, text})` call
  (GM_notification-backed, console-fallback).
- **Logging style**: all gated debug/info/warn output goes through `dbg`/`dbgInfo`/`dbgWarn`/
  `dbgGroup`/`dbgGroupEnd` from `lib/admincom-common.js`, format `` `[${MODULE_PREFIX}:${tag}]` ``,
  no-op unless `isDebugEnabled()` is true. Always-visible failure logs (meant to reach an admin even
  without debug mode on) use plain `console.error`/`console.warn` directly — this split was
  deliberately preserved during the debug-logging centralization.
- **Sensitive-data redaction**: no secrets are logged or stored — there are no API tokens/credentials
  anywhere in the codebase (PeeringDB auth is same-origin session cookies).
- **Documentation convention**: functions carry a JSDoc block with `Purpose:`, `Necessity:`, and an
  `@ai Preserve ...` / `@ai Keep behavior stable and prefer minimal, localized edits.` tag flagging
  behavior contracts — 900+ occurrences across the repo. This is a repo-specific convention for
  guiding AI-assisted edits, documented in [AGENTS.md](../AGENTS.md).

## Testing

No test files, framework, or directory exist anywhere in the repo — see [AGENTS.md](../AGENTS.md)
"Testing" for the manual verification workflow that stands in for one.
