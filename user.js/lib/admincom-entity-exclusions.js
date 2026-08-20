// Shared two-tier entity-exclusion data for the admincom Tampermonkey
// userscripts (CP/FP/DeskPro).
//
// This is a source fragment, not a standalone script: it is inlined into
// each *.user.js by scripts/build_userscripts.py at the `/* @include
// admincom-entity-exclusions.js */` marker in that script's *.src.js.
// Edit this file, then re-run the build script -- do not hand-edit the
// generated block inside the .user.js files, your changes will be
// overwritten.
//
// Everything keys on the canonical short entity types, which are the
// PeeringDB API resource names: net, ix, org, fac, carrier, campus.
// Normalize route- or model-specific spellings through
// normalizeExcludedEntityType() before consulting either map.

// Org 20525 "Dummy Organisation to hold Suggested Entities" -- the org
// PeeringDB parks suggested entities under until they are approved.
// Defined here (and only here) because the update-name map below lists
// it; scripts also consult it directly, e.g. CP's suggested-facility
// check.
const DUMMY_ORG_ID = 20525;

/**
 * Entities the scripts must never touch in any way -- no writes, no
 * flagging for changes, no mutation of any kind: org 25554 "PeeringDB
 * Example Organization" and every child record it owns -- nothing else.
 * Verified against the public API on 2026-08-20: nets 666 "PeeringDB
 * Example 32-bit Network" and 32281 "PeeringDB Example 16-bit Network",
 * ix 4095 "PeeringDB Example IX", facilities 13346/13399, carrier 66
 * and campus 25. FP's IX-F netixlan write paths consult the net and ix
 * sets today; the remaining types are listed so any future write path
 * keys on the same map. Org 20525 (DUMMY_ORG_ID) stays an update-name
 * exclusion only.
 */
const EXAMPLE_ORG_DO_NOT_TOUCH_ENTITY_IDS = {
  net: new Set(["32281", "666"]),
  ix: new Set(["4095"]),
  org: new Set(["25554"]),
  fac: new Set(["13346", "13399"]),
  carrier: new Set(["66"]),
  campus: new Set(["25"]),
};

/**
 * Entities excluded from the update-name tooling beyond the
 * do-not-touch cluster above: real third-party records -- AFNIC
 * (net 2858/14185), DNS-OARC (net 10664), NIC.br (net 24084), AS8882
 * (net 29032, org 31503), Digital Example (net 31754, org 34028) --
 * whose names must not be auto-edited but whose data remains writable
 * via normal admin writes, plus the dummy suggested-entities org.
 * Extend by appending IDs to the relevant list.
 */
const UPDATE_NAME_EXCLUDED_ADDITIONAL_IDS = {
  net: ["31754", "29032", "14185", "2858", "24084", "10664"],
  org: ["34028", String(DUMMY_ORG_ID), "31503"],
};

/**
 * Entity IDs excluded from the update-name tooling -- that is this map's
 * only purpose. Derived, not hand-listed: everything the scripts must
 * never touch at all (EXAMPLE_ORG_DO_NOT_TOUCH_ENTITY_IDS -- never
 * touched means never name-edited either) plus the update-name-only
 * entries above, so the Example Organization ids are stated exactly
 * once. Never key destructive write guards on this map 1:1; that is
 * what EXAMPLE_ORG_DO_NOT_TOUCH_ENTITY_IDS is for.
 */
const UPDATE_NAME_EXCLUDED_ENTITY_IDS = Object.fromEntries(
  Object.entries(EXAMPLE_ORG_DO_NOT_TOUCH_ENTITY_IDS).map(([type, ids]) => [
    type,
    new Set([...ids, ...(UPDATE_NAME_EXCLUDED_ADDITIONAL_IDS[type] || [])]),
  ]),
);

/**
 * Entity-type spellings normalized to the canonical short types the maps
 * above key on: FP frontend route segments (net, asn, ...) and CP
 * django-admin model names (network, internetexchange, ...) alike.
 */
const EXCLUDED_ENTITY_TYPE_ALIASES = {
  net: "net",
  asn: "net",
  network: "net",
  ix: "ix",
  internetexchange: "ix",
  org: "org",
  organization: "org",
  fac: "fac",
  facility: "fac",
  carrier: "carrier",
  campus: "campus",
};

/**
 * Resolves an entity type or alias to its canonical short type.
 * @param {string} type - Entity type or alias (see EXCLUDED_ENTITY_TYPE_ALIASES).
 * @returns {string} Canonical entity type, or empty string if unsupported.
 */
function normalizeExcludedEntityType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  return EXCLUDED_ENTITY_TYPE_ALIASES[normalized] || "";
}
