The `.user.js` scripts in this folder can be added to the web browser using the Tampermonkey extension.

Tampermonkey is available from their homepage ([tampermonkey.net](https://www.tampermonkey.net/)).

## Metadata convention

Each script has a matching `.meta.js` file for lightweight update checks.

Script versioning follows server format:

- `major.minor.bugfix.YYYYMMDD`

- `@updateURL` points to the script's `.meta.js` file
- `@downloadURL` points to the script's `.user.js` file
- `@supportURL` points to: `https://github.com/peeringdb/admincom/issues`

All update and download URLs use this base path:

- `https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/`

Footnote: Scripts can be installed directly from GitHub _after_ [this script](https://github.com/jesus2099/konami-command/raw/master/INSTALL-USER-SCRIPT.user.js) has been installed.

## CP consolidation and migration

All legacy Control Panel (`peeringdb-cp-*`) scripts have been consolidated into one modular userscript:

- `peeringdb-cp-consolidated-tools.user.js`
- `peeringdb-cp-consolidated-tools.meta.js`

The consolidated script is scoped to `https://www.peeringdb.com/cp/peeringdb_server/*/*/change/*` and uses strict route guards so only relevant module behavior runs on matching pages.

## FP consolidation and migration

All legacy Frontend (`peeringdb-fp-*`) scripts have been consolidated into one modular userscript:

- `peeringdb-fp-consolidated-tools.user.js`
- `peeringdb-fp-consolidated-tools.meta.js`

## Module feature flags (CP + FP)

Both consolidated scripts support disabling specific modules with `localStorage`.

- CP key: `pdbCpConsolidated.disabledModules`
- FP key: `pdbFpConsolidated.disabledModules`

### User-Agent Configuration (CP + FP)

Both scripts support trust-based User-Agent generation inspired by the [python_modules/useragent.py](../python_modules/useragent.py) module:

**Trust-Based Logic:**
- **Trusted domains** (peeringdb.com, *.peeringdb.com, api.peeringdb.com, 127.0.0.1, localhost): Full-detail UA including browser platform, session UUID, e.g. `PeeringDB-Admincom-CP-Consolidated (Windows NT 10.0 uuid/123abc...)`
- **Untrusted domains** (other origins in extension requests): Privacy-preserving UA with 16-char Client Fingerprint (deterministic hash of browser attributes) + session UUID, e.g. `PeeringDB-Admincom-CP-Consolidated (fingerprint/a3f2c8e1d4b6f9a2 uuid/123abc...)`

**Storage Keys:**
- CP User-Agent key: `pdbCpConsolidated.userAgent` (localStorage)
- FP User-Agent key: `pdbFpConsolidated.userAgent` (localStorage)
- CP Session UUID key: `pdbCpConsolidated.sessionUuid` (sessionStorage)
- FP Session UUID key: `pdbFpConsolidated.sessionUuid` (sessionStorage)

**Default behavior (no localStorage override):**
- Scripts auto-compute trust-based UA on each request based on target domain
- Session UUID is generated once per session and persisted in `sessionStorage`
- Client Fingerprint is computed deterministically from browser attributes (userAgent, platform, language, hardwareConcurrency, deviceMemory)

**Optional localStorage override:**
- CP custom User-Agent: `pdbCpConsolidated.userAgent`
- FP custom User-Agent: `pdbFpConsolidated.userAgent`
- When set, overrides auto-computed trust-based UA

Values can be either:

- JSON array: `"[\"module-a\",\"module-b\"]"`
- Comma-separated string: `"module-a,module-b"`

### Console examples

Disable one CP module:

```js
localStorage.setItem("pdbCpConsolidated.disabledModules", '["reset-network-information"]');
```

Disable multiple FP modules:

```js
localStorage.setItem("pdbFpConsolidated.disabledModules", "copy-user-roles,admin-console-link");
```

Re-enable all modules:

```js
localStorage.removeItem("pdbCpConsolidated.disabledModules");
localStorage.removeItem("pdbFpConsolidated.disabledModules");
```

Inspect auto-computed CP User-Agent (trust-based, no override):

```js
console.log("Session UUID:", window.sessionStorage?.getItem("pdbCpConsolidated.sessionUuid"));
console.log("CPU configured?:", !!localStorage.getItem("pdbCpConsolidated.userAgent"));
```

Set custom CP request User-Agent (overrides auto-computed):

```js
localStorage.setItem("pdbCpConsolidated.userAgent", "PeeringDB-Admincom/CP-RDAP (+tampermonkey)");
```

Set custom FP request User-Agent:

```js
localStorage.setItem("pdbFpConsolidated.userAgent", "PeeringDB-Admincom/FP (+custom)");
```

Reset CP/FP User-Agent to auto-computed (trust-based logic):

```js
localStorage.removeItem("pdbCpConsolidated.userAgent");
localStorage.removeItem("pdbFpConsolidated.userAgent");
```

After updating flags, reload the page so modules are re-evaluated.

Note: User-Agent (whether auto-computed or overridden) applies to script-originated extension requests only (for example RDAP lookups in CP). It does not change normal browser navigation/request User-Agent. FP currently has no extension request paths; UA scaffolding is pre-wired for future use.

## Module ID catalog

Use these module IDs with the CP/FP `disabledModules` keys.

### CP module IDs (`peeringdb-cp-consolidated-tools.user.js`)

- `copy-frontend-urls`
- `facility-google-maps`
- `entity-website-new-tab`
- `highlight-dummy-org-child`
- `frontend-links`
- `search-user-email-by-username`
- `set-network-name-equal-org-name`
- `reset-network-information`
- `set-window-title`

#### CP one-line disable examples

```js
localStorage.setItem("pdbCpConsolidated.disabledModules", '["copy-frontend-urls"]');
localStorage.setItem("pdbCpConsolidated.disabledModules", '["facility-google-maps"]');
localStorage.setItem("pdbCpConsolidated.disabledModules", '["entity-website-new-tab"]');
localStorage.setItem("pdbCpConsolidated.disabledModules", '["highlight-dummy-org-child"]');
localStorage.setItem("pdbCpConsolidated.disabledModules", '["frontend-links"]');
localStorage.setItem("pdbCpConsolidated.disabledModules", '["search-user-email-by-username"]');
localStorage.setItem("pdbCpConsolidated.disabledModules", '["set-network-name-equal-org-name"]');
localStorage.setItem("pdbCpConsolidated.disabledModules", '["reset-network-information"]');
localStorage.setItem("pdbCpConsolidated.disabledModules", '["set-window-title"]');
```

### FP module IDs (`peeringdb-fp-consolidated-tools.user.js`)

- `fix-double-slashes`
- `set-window-title`
- `admin-console-link`
- `copy-record-data`
- `copy-user-roles`

#### FP one-line disable examples

```js
localStorage.setItem("pdbFpConsolidated.disabledModules", '["fix-double-slashes"]');
localStorage.setItem("pdbFpConsolidated.disabledModules", '["set-window-title"]');
localStorage.setItem("pdbFpConsolidated.disabledModules", '["admin-console-link"]');
localStorage.setItem("pdbFpConsolidated.disabledModules", '["copy-record-data"]');
localStorage.setItem("pdbFpConsolidated.disabledModules", '["copy-user-roles"]');
```

### Whitelist troubleshooting examples (enable only selected modules)

These one-liners disable every other known module, leaving only the listed module(s) enabled.

Enable only `reset-network-information` in CP:

```js
localStorage.setItem("pdbCpConsolidated.disabledModules", JSON.stringify(["copy-frontend-urls","facility-google-maps","entity-website-new-tab","highlight-dummy-org-child","frontend-links","search-user-email-by-username","set-network-name-equal-org-name","set-window-title"]));
```

Enable only `admin-console-link` in FP:

```js
localStorage.setItem("pdbFpConsolidated.disabledModules", JSON.stringify(["fix-double-slashes","set-window-title","copy-record-data","copy-user-roles"]));
```

Enable only `admin-console-link` and `copy-record-data` in FP:

```js
localStorage.setItem("pdbFpConsolidated.disabledModules", JSON.stringify(["fix-double-slashes","set-window-title","copy-user-roles"]));
```

### Generic whitelist helper one-liners

Set `enabled` to the module IDs you want active; each helper computes and stores all other known modules as disabled.

CP generic helper:

```js
(() => { const all = ["copy-frontend-urls","facility-google-maps","entity-website-new-tab","highlight-dummy-org-child","frontend-links","search-user-email-by-username","set-network-name-equal-org-name","reset-network-information","set-window-title"]; const enabled = ["reset-network-information"]; localStorage.setItem("pdbCpConsolidated.disabledModules", JSON.stringify(all.filter((id) => !enabled.includes(id)))); })();
```

FP generic helper:

```js
(() => { const all = ["fix-double-slashes","set-window-title","admin-console-link","copy-record-data","copy-user-roles"]; const enabled = ["admin-console-link"]; localStorage.setItem("pdbFpConsolidated.disabledModules", JSON.stringify(all.filter((id) => !enabled.includes(id)))); })();
```


### Legacy CP scripts

The following legacy CP scripts are now deprecation stubs and only log a console message pointing to the consolidated script:

- `peeringdb-cp-add-facility-address-search-to-google-maps.user.js`
- `peeringdb-cp-admin-console-set-link-target-blank-for-entity-website.user.js`
- `peeringdb-cp-control-panel-hightlight-dummy-organization-child-object.user.js`
- `peeringdb-cp-frontpage-link-on-admin-console.user.js`
- `peeringdb-cp-reset-all-network-information.user.js`
- `peeringdb-cp-search-user-e-mail-addresses-from-username.user.js`
- `peeringdb-cp-set-network-name-equal-to-organisation-name.user.js`

### Legacy FP scripts

The following legacy FP scripts are now deprecation stubs:

- `peeringdb-fp-admin-console-link-on-frontpage.user.js`
- `peeringdb-fp-copy-record-to-clipboard.user.js`
- `peeringdb-fp-copy-user-role-list.user.js`
- `peeringdb-fp-replace-double-slashes-in-uri.user.js`
- `peeringdb-fp-set-window-title.user.js`

Each legacy `.meta.js` remains in place and version-synced to support update checks and explicit migration.
