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
