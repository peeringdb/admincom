# External Integrations

## Integration Inventory

| System | Type | Purpose | Auth model | Criticality |
|--------|------|---------|------------|-------------|
| PeeringDB REST API (`peeringdb.com`, `beta.peeringdb.com`) | Same-origin REST API | CP: org/network/facility record reads & writes (renumber, merge, conflict-resolve). FP: entity-page reads, and (as of the `netixlan-ixf-verify` module) writes — PUT to correct `speed`/`is_rs_peer`/`operational` on a netixlan row, or DELETE a netixlan row IX-F doesn't list. DP: cross-origin lookups backing DeskPro ticket enrichment | Browser session cookie (same-origin fetch); FP writes additionally carry an `X-CSRFToken` header read from the page's own hidden `csrfmiddlewaretoken` input/cookie | High |
| RDAP registries (`rdap.arin.net`, `rdap.db.ripe.net`, `rdap.apnic.net`, `rdap.lacnic.net`, `rdap.afrinic.net`, `data.iana.org`) | Public read-only APIs | CP-only ASN → organization-name fallback lookups | None (public) | Medium |
| IX-F member-export URLs (arbitrary operator-defined hosts) | Public JSON export | CP: IX-F Member Audit module cross-checks `ixf_ixp_member_list_url` for bulk split-row merge detection on one ixlan. FP: `netixlan-ixf-verify` module fetches the same kind of feed for a single netixlan row's own exchange, for a per-row verify/diff/resolve flow | None; `anonymous: true` GM request | Medium |
| DeskPro (`peeringdb.deskpro.com`) | Host application (the script runs *inside* it) | Ticket-page UI enrichment | N/A — runs as a userscript on the page, not an API caller of DeskPro | High (DP's only host) |
| `cdnjs.cloudflare.com` (PSL library, `psl.min.js` v1.12.0) | Static script CDN | Hostname/domain parsing for the DeskPro Whitelist CMD Generator | None | Low |

RDAP ownership is CP-only — FP/DP do not assume parity (`peeringdb-cp-consolidated-tools.src.js:36`).
**Both CP and FP** now carry the `GM_xmlhttpRequest` grant and an `@connect *` wildcard (FP gained
this when the `netixlan-ixf-verify` feature was added). CP and FP have zero `@require` directives;
DeskPro's PSL `@require` has no SRI hash (see [CONCERNS.md](CONCERNS.md)).

## Data Stores

| Store | Role | Access layer | Key risk |
|-------|------|---------------|----------|
| Browser `localStorage` | Per-script settings (disabled modules, custom User-Agent, debug flag) | Direct `window.localStorage.getItem/setItem` calls throughout each `.src.js` | Shared origin means CP and FP settings can collide if a key isn't properly namespaced (mitigated: `${MODULE_PREFIX}.*` namespacing, see [README.md](../README.md)) |
| Browser `localStorage` (API-entity cache) | Caches resolved PeeringDB API objects (org/net/ix/fac/carrier/asn) to cut down repeat requests | `getCachedDataFromStorage`/`setCachedDataInStorage` in `lib/admincom-common.js`, key format `pdbAdmincom.cache.<type>.<id>`, versioned schema + TTL per entry | Origin-scoped: CP and FP genuinely share entries (both run on `peeringdb.com`); DP (`peeringdb.deskpro.com`) uses the identical mechanism but can **never** see CP/FP's entries or vice versa — that's the browser's same-origin storage isolation, not a bug to fix |
| Browser `sessionStorage` | Per-tab session UUID for User-Agent fingerprinting | `window.sessionStorage.getItem/setItem` | None significant — session-scoped, non-sensitive |

No server-side database — there is no server component to this repo at all.

## Secrets and Credentials

No API tokens, passwords, or secrets are read, stored, or transmitted by any script — confirmed via
repo-wide grep for `GM_getValue`/`GM_setValue` (zero matches; these grants aren't even requested in
any `.meta.js`). The `@connect *` grant on CP and FP is a *network destination* allowlist relaxation
(required because IX-F export hosts are operator-defined and can't be enumerated in advance), not a
credential. Nothing to rotate.

## Reliability and Failure Behavior

- **Retry/backoff**: shared and centralized — `fetchWithRetry`/`gmRequestWithRetry` in
  `lib/admincom-common.js`, with exponential backoff and `Retry-After` header parsing on
  `429`/`502`/`503`/`504`. DeskPro additionally layers a *proactive* rate-limit-quota pre-check
  (`shouldBackoffRateLimit()`, reads `x-ratelimit-remaining`/`x-ratelimit-reset` response headers) in
  front of the shared reactive wrapper.
- **Timeout policy**: `REQUEST_TIMEOUT_MS` (15000ms default) in the shared lib, overridable per call.
- **Circuit-breaker/fallback**: none beyond the retry/backoff above; the RDAP client's JSDoc
  explicitly documents "graceful degradation" (returns `null` on failure rather than throwing) so
  CP's org-name resolution silently falls back rather than blocking.

## Observability

- Logging around external calls is gated — `dbg('http', ...)` logs each retry attempt
  (`lib/admincom-common.js`); RDAP lookups in CP log via `dbg('rdap', ...)`/`dbgWarn('rdap', ...)`;
  FP's IX-F verify flow logs via `dbg('ixf-verify', ...)`.
- No metrics/tracing — no APM, no metrics endpoint, no distributed tracing (there's no backend to
  report to).
- No persistent record of retry/failure rates beyond what's visible in a live browser console during
  a debug session.
