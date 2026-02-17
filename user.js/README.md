The `.user.js` scripts in this folder can be added to the web browser using the Tampermonkey extension.

Tampermonkey is available from their homepage ([tampermonkey.net](https://www.tampermonkey.net/)).

## Metadata convention

Each script has a matching `.meta.js` file for lightweight update checks.

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

### Legacy CP scripts

The following legacy CP scripts are now deprecation stubs and only log a console message pointing to the consolidated script:

- `peeringdb-cp-add-facility-address-search-to-google-maps.user.js`
- `peeringdb-cp-admin-console-set-link-target-blank-for-entity-website.user.js`
- `peeringdb-cp-control-panel-hightlight-dummy-organization-child-object.user.js`
- `peeringdb-cp-frontpage-link-on-admin-console.user.js`
- `peeringdb-cp-reset-all-network-information.user.js`
- `peeringdb-cp-search-user-e-mail-addresses-from-username.user.js`
- `peeringdb-cp-set-network-name-equal-to-organisation-name.user.js`

Each legacy `.meta.js` remains in place and version-synced to support update checks and explicit migration.
