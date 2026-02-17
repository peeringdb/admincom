// ==UserScript==
// @name         PeeringDB CP - Add facility address search to Google Maps
// @namespace    https://www.peeringdb.com/cp/peeringdb_server/facility/
// @version      1.2.0.20260217
// @description  Add a google maps link to the facility page
// @author       <chriztoffer@peeringdb.com>
// @include      /^https:\/\/(\w+)\.peeringdb\.com\/cp\/peeringdb_server\/facility\/(\d+)\/change\/(.*)?
// @icon         https://icons.duckduckgo.com/ip2/peeringdb.com.ico
// @grant        none
// @updateURL    https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-add-facility-address-search-to-google-maps.meta.js
// @downloadURL  https://raw.githubusercontent.com/peeringdb/admincom/master/user.js/peeringdb-cp-add-facility-address-search-to-google-maps.user.js
// @supportURL   https://github.com/peeringdb/admincom/issues
// ==/UserScript==

(function() {
  'use strict';

  let padLeft = 459;
  let linkText = 'Google Maps';

  // Google Maps link
  let maps = 'https://www.google.com/maps?q=';

  // Get all the necessary address information fields from the current facility page
  let address1 = document.querySelector('#id_address1').getAttribute('value');
  let address2 = document.querySelector('#id_address2').getAttribute('value');
  let city = document.querySelector('#id_city').getAttribute('value');
  let state = document.querySelector('#id_state').getAttribute('value');
  let zipcode = document.querySelector('#id_zipcode').getAttribute('value');
  // The country code is only available as alpha-3166
  let country = document.querySelector('#id_country > option[selected]').getAttribute('value');
  let latitude = document.querySelector('#id_latitude').getAttribute('value');
  let longtitude = document.querySelector('#id_longitude').getAttribute('value');

  // Construct the HREF and URL encode the query string appended
  // to the google maps link.
  //
  // We default to using lat,long for the query. If these values are
  // not present. We default to encoding the address as a fallback.
  let query = encodeURIComponent(
    (latitude && longtitude) ? latitude + ',' + longtitude : ((address1) ? address1 : '') + ((city) ? '+' + city : '') + ((state) ? '+' + state : '') + ((zipcode) ? '+' + zipcode : '') + ((country) ? '+' + country : '')
  );

  let link = maps + query;

  const childNode = document.createElement('ul');
  const parentNode = document.querySelector('#grp-content-title > ul').parentNode;

  childNode.innerHTML += '<li class="grp-object-tools" style="padding-right:' + padLeft + 'px;">' + '<a href="' + link + '" target="' + encodeURIComponent(query) + '">' + linkText + '</a>' + '</li>';

  let sp2 = document.querySelector('#grp-content-title > ul');
  parentNode.insertBefore(childNode, sp2);

  console.log(link);
})();