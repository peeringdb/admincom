// ==UserScript==
// @name            PeeringDB FP - Set window title
// @namespace       https://www.peeringdb.com
// @description     Updates the Window Title in your Browser
// @author          <chriztoffer@peeringdb.com>
// @match           https://www.peeringdb.com/asn/*
// @match           https://www.peeringdb.com/org/*
// @match           https://www.peeringdb.com/net/*
// @match           https://www.peeringdb.com/ix/*
// @match           https://www.peeringdb.com/fac/*
// @match           https://www.peeringdb.com/cp/peeringdb_server/user/*
// @match           https://www.peeringdb.com/cp/peeringdb_server/network/*
// @match           https://www.peeringdb.com/cp/peeringdb_server/facility/*
// @match           https://www.peeringdb.com/cp/peeringdb_server/carrier/*
// @match           https://www.peeringdb.com/cp/peeringdb_server/organization/*
// @match           https://www.peeringdb.com/cp/peeringdb_server/internetexchange/*
// @icon            https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @version         1.4.0.20260217
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-set-window-title.meta.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-fp-set-window-title.user.js
// @supportURL      https://github.com/peeringdb/admincom/issues
// ==/UserScript==

var url = null,
    isTitleUpdated = false,
    isControlPanel = false,
    PDB_TITLE,
    PDB_TITLE_SHORT,
    PDB_TITLE_LONG,
    PDB_TYPE,
    PDB_ASN,
    PDB_WINDOW_TITLE,
    PDB_TITLE_AKA,
    isNetwork = false,
    isIxp = false,
    sep = ' | ';

if ((url = location.href.match(/www\.peeringdb\.com\/(net|ix|asn|org|fac)\/([0-9]+)/))) {
  if (url !== null) {

    let type = url[1],
        id = url[2];

    PDB_TYPE = type; // Extract type from ULR.
    PDB_TITLE_SHORT = document.querySelector('div[data-edit-name="name"]').getAttribute('data-edit-value'); // Get object title.
    PDB_TITLE = PDB_TITLE_SHORT;

    if (PDB_TYPE == 'asn' || PDB_TYPE == 'net') {
      isNetwork = true;
      PDB_ASN = document.querySelector('div[data-edit-name="asn"]').innerHTML.match(/^(\d+)/)[0]; // Get AS [numeric] number.
      PDB_TYPE = 'as' + PDB_ASN; // Write AS[number] instead of asn or net.
      PDB_TITLE_AKA = document.querySelector('div[data-edit-name="aka"]').innerHTML;
      if (PDB_TITLE_AKA != PDB_TITLE_SHORT && PDB_TITLE_AKA.length > 0) {
        PDB_TITLE += ' (a.k.a. ' + PDB_TITLE_AKA + ')';
      }
    }

    if (PDB_TYPE == 'ix') {
      isIxp = true;
      PDB_TYPE = 'ixp'; // Write IXP instead of just IX.
      PDB_TITLE_LONG = document.querySelector('div[data-edit-name="name_long"]').innerHTML; // Get long name
      if (PDB_TITLE_LONG.length > 0) {
        PDB_TITLE = PDB_TITLE_LONG; // Set long name instead of short.
      }
    }

    isTitleUpdated = true;
  }

}

if ((url = location.href.match(/www\.peeringdb\.com\/cp\/peeringdb_server\/(user|network|carrier|facility|internetexchange|organization)\/([0-9]+)\/change\/?/))) {
  if (url !== null) {

    let type = url[1],
        id = url[2];

    var username = '',
        email = '',
        name = '',
        country = '';

    if (type == 'user') {
      username = document.querySelector('#id_username').getAttribute('value');
      email = document.querySelector('#id_email').getAttribute('value');

      username = sep + username + sep + email;
    }

    if (type == 'facility' || type == 'organization') {
      name = document.querySelector('#id_name').getAttribute('value');
      country = document.querySelector('#id_country > option[selected]').innerText;

      name = sep + name + sep + country;
    }

    /* Missing cases for network|carrier|facility|internetexchange|organization */

    PDB_TYPE = type;
    PDB_TITLE = id + username + name;

    isControlPanel = true;
    isTitleUpdated = true;
  }
}

if (isTitleUpdated == true) {
  PDB_WINDOW_TITLE = isControlPanel ? 'PDB CP' : 'PDB'; // Declare title prefix.
  PDB_WINDOW_TITLE += sep + PDB_TYPE.toUpperCase(); // Append objetc type in uppercase.
  PDB_WINDOW_TITLE += sep + PDB_TITLE; // Append object title.
  PDB_WINDOW_TITLE += isNetwork ? sep + PDB_TYPE.toLowerCase() + '.peeringdb.com' : ''; // Append short-hand network url.

  console.log("Window title changed from: " + document.title); // log previous window title

  document.title = PDB_WINDOW_TITLE;

  console.log("Window title changed to: " + document.title); // log new window title
}
