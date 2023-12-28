// ==UserScript==
// @name            PeeringDB - Set window title
// @namespace       PeeringDB
// @description     Updates the Window Title in your Browser
// @author          <chriztoffer@PeeringDB.com>
// @match           https://www.peeringdb.com/asn/*
// @match           https://www.peeringdb.com/org/*
// @match           https://www.peeringdb.com/net/*
// @match           https://www.peeringdb.com/ix/*
// @match           https://www.peeringdb.com/fac/*
// @version         1.2.6.20231228
// @updateURL       https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-set-window-title.user.js
// @downloadURL     https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-set-window-title.user.js
// ==/UserScript==

var url;
url = null;

if ((url = location.href.match(/peeringdb\.com\/(net|ix|asn|org|fac)\/([0-9]+)/))) {
  if (url !== null) {
    var PDB_TITLE, PDB_TITLE_SHORT, PDB_TITLE_LONG, PDB_TYPE, PDB_ASN, PDB_WINDOW_TITLE, PDB_TITLE_AKA;

    var isNetwork = false,
      isIxp = false;

    var sep = ' | ';

    PDB_TYPE = url[1]; // Extract type from ULR.
    PDB_TITLE_SHORT = document.querySelector('div[data-edit-name="name"]').innerHTML; // Get object title.
    PDB_TITLE = PDB_TITLE_SHORT;

    if (PDB_TYPE == 'asn' || PDB_TYPE == 'net') {
      isNetwork = true;
      PDB_ASN = document.querySelector('div[data-edit-name="asn"]').innerHTML; // Get AS [numeric] number.
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

    PDB_WINDOW_TITLE = 'PDB'; // Declare title prefix.
    PDB_WINDOW_TITLE += sep + PDB_TYPE.toUpperCase(); // Append objetc type in uppercase.
    PDB_WINDOW_TITLE += sep + PDB_TITLE; // Append object title.
    PDB_WINDOW_TITLE += isNetwork ? sep + PDB_TYPE.toLowerCase() + '.peeringdb.com' : ''; // Append short-hand network url.

    console.log("Window title changed from: " + document.title); // log previous window title

    document.title = PDB_WINDOW_TITLE;

    console.log("Window title changed to: " + document.title); // log new window title
  }
}
