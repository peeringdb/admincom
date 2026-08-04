'use strict';

// Characterization tests for lib/cp-name-normalization.js -- CP's org/RDAP
// name-normalization helpers. This is the highest regex-complexity, highest
// silent-regression-risk surface in the whole repo (150+ legal-suffix
// patterns spanning dozens of jurisdictions), and until now had zero
// automated coverage. Expected values below were captured by running the
// actual functions (not derived from the JSDoc examples alone -- a few of
// those examples describe an intermediate step, not the final return value,
// and one function's own documented example does not currently resolve the
// way its docstring claims; see the "known discrepancy" test below). The
// goal here is locking in current behavior, not asserting what "should"
// happen per the docs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadPureLib } = require('./helpers/pure-lib-loader');

const lib = loadPureLib(
  path.join(__dirname, '..', 'lib', 'cp-name-normalization.js'),
  [
    'hasBalancedParens',
    'stripCompanyTypeSuffix',
    'stripOrganizationalUnitDescriptor',
    'resolveCompactNameFromCommaLegalAliases',
    'stripTrailingRegistrationIdentifier',
    'compactEntityNameWithLongNameFallback',
    'normalizeSimpleSingleDashAlphabeticName',
    'collapseExactCommaDuplicateName',
    'containsAsnLikeToken',
    'isLikelyGeneratedHandleName',
    'sanitizeRdapOrgName',
    'parseRdapTradingAsIdentity',
    'parsePolishScPartnerIdentity',
    'looksLikePersonalNameShape',
    'parseParenthesizedTradeNameIdentity',
    'parseOrganizationNameIdentity',
    'getDeterministicNetworkFallbackName',
    'pickPreferredNetworkNameCandidate',
  ],
);

test('hasBalancedParens', () => {
  assert.equal(lib.hasBalancedParens('Power Line (HK)'), true);
  assert.equal(lib.hasBalancedParens('Power Line (HK'), false);
  assert.equal(lib.hasBalancedParens('Power Line HK)'), false);
  assert.equal(lib.hasBalancedParens(''), true);
});

test('stripCompanyTypeSuffix', async (t) => {
  await t.test('strips a trailing legal form', () => {
    assert.equal(lib.stripCompanyTypeSuffix('Acme Networks GmbH'), 'Acme Networks');
  });

  await t.test('"Trade Me" is a hardcoded false-positive exception', () => {
    assert.equal(lib.stripCompanyTypeSuffix('Trade Me'), 'Trade Me');
  });

  await t.test('ASCII-transliterated Turkish "Limited Sirketi" is recognized', () => {
    assert.equal(
      lib.stripCompanyTypeSuffix('AnatoliaCore Teknoloji Limited Sirketi'),
      'AnatoliaCore Teknoloji',
    );
  });

  await t.test('trailing "<legal form>, <location>" collapses through EOOD/OOD/DOO first, then strips the legal form itself', () => {
    // The trailing-location normalization step alone would stop at "DGM EOOD"
    // (see the function's own doc comment) but EOOD is itself a recognized
    // legal suffix, so the main stripping loop continues to "DGM".
    assert.equal(lib.stripCompanyTypeSuffix('DGM EOOD, Sofia, Bulgaria'), 'DGM');
  });

  await t.test('trailing "<legal form> <ISO country code>" reorders and strips', () => {
    assert.equal(lib.stripCompanyTypeSuffix('Phylaxis, Inc. USA'), 'Phylaxis');
  });

  await t.test('empty and no-suffix input pass through unchanged', () => {
    assert.equal(lib.stripCompanyTypeSuffix(''), '');
    assert.equal(lib.stripCompanyTypeSuffix('Just A Name'), 'Just A Name');
  });
});

test('known discrepancy: resolveCompactNameFromCommaLegalAliases does not currently handle its own documented "SDN BHD" / "Berhad" example', () => {
  // The function's docstring claims to handle "FOO SDN BHD, Foo Berhad" as
  // matching aliases, but the legal-suffix pattern list only recognizes the
  // combined "Sdn Bhd" form, not a standalone spelled-out "Berhad" -- so
  // "Foo Berhad" never loses its suffix, the two stripped forms don't match,
  // and this currently resolves to "" (not treated as an alias pair). This
  // test exists to flag the gap, not to assert it's correct -- worth a
  // real fix in a follow-up if RDAP data actually produces this shape.
  assert.equal(lib.resolveCompactNameFromCommaLegalAliases('FOO SDN BHD, Foo Berhad'), '');
});

test('resolveCompactNameFromCommaLegalAliases resolves a genuine alias pair', () => {
  assert.equal(
    lib.resolveCompactNameFromCommaLegalAliases('Acme Ltd, Acme Inc'),
    'Acme',
  );
});

test('stripOrganizationalUnitDescriptor', async (t) => {
  await t.test('drops a trailing department/division descriptor', () => {
    assert.equal(
      lib.stripOrganizationalUnitDescriptor('Company, Data Network Management Division'),
      'Company',
    );
  });

  await t.test('drops a "<name>, <legal form>, ISP <descriptor>" tail', () => {
    assert.equal(
      lib.stripOrganizationalUnitDescriptor('NovInvestRezerv, LLC, ISP NIR-Telecom'),
      'NovInvestRezerv',
    );
  });

  await t.test('leaves names without a recognized unit descriptor unchanged', () => {
    assert.equal(lib.stripOrganizationalUnitDescriptor('Acme, Cloud Services'), 'Acme, Cloud Services');
  });
});

test('stripTrailingRegistrationIdentifier', async (t) => {
  await t.test('drops a trailing registration-number segment', () => {
    assert.equal(
      lib.stripTrailingRegistrationIdentifier('Company PTE. LTD., 202208375N'),
      'Company PTE. LTD.',
    );
  });

  await t.test('drops trailing symbol-noise', () => {
    assert.equal(
      lib.stripTrailingRegistrationIdentifier('GLOBALGRID SASU, ************'),
      'GLOBALGRID SASU',
    );
  });

  await t.test('drops a bare hex verification-token tail', () => {
    assert.equal(
      lib.stripTrailingRegistrationIdentifier('Samuel Cosgrove, f2939b32ff3768abf6202405ced14e89'),
      'Samuel Cosgrove',
    );
  });
});

test('normalizeSimpleSingleDashAlphabeticName', () => {
  assert.equal(lib.normalizeSimpleSingleDashAlphabeticName('Locl-net'), 'Locl net');
  assert.equal(lib.normalizeSimpleSingleDashAlphabeticName('Not-A-Multi-Dash-Name'), 'Not-A-Multi-Dash-Name');
});

test('collapseExactCommaDuplicateName', async (t) => {
  await t.test('2-part exact duplicate collapses', () => {
    assert.equal(lib.collapseExactCommaDuplicateName('Name, Name'), 'Name');
  });

  await t.test('4-part duplicate halves collapse', () => {
    assert.equal(
      lib.collapseExactCommaDuplicateName('COMPANY CO., LTD, COMPANY CO., LTD'),
      'COMPANY CO., LTD',
    );
  });

  await t.test('non-duplicate is left unchanged', () => {
    assert.equal(lib.collapseExactCommaDuplicateName('Acme, Ltd'), 'Acme, Ltd');
  });
});

test('containsAsnLikeToken', () => {
  assert.equal(lib.containsAsnLikeToken('AS123456'), true);
  assert.equal(lib.containsAsnLikeToken('ASN 654321'), true);
  assert.equal(lib.containsAsnLikeToken('no numbers here'), false);
});

test('isLikelyGeneratedHandleName', () => {
  assert.equal(lib.isLikelyGeneratedHandleName('VIPY-MNT'), true);
  assert.equal(lib.isLikelyGeneratedHandleName('ru-atss'), true);
  assert.equal(lib.isLikelyGeneratedHandleName('Acme Networks'), false);
});

test('sanitizeRdapOrgName strips appended remarks', () => {
  assert.equal(lib.sanitizeRdapOrgName('Name, remarks: GARBAGE'), 'Name');
});

test('parseRdapTradingAsIdentity splits person/company', () => {
  assert.deepStrictEqual(
    lib.parseRdapTradingAsIdentity('Remzi Toker trading as VENTURESDC'),
    { name: 'VENTURESDC', knownAs: 'Remzi Toker' },
  );
});

test('parsePolishScPartnerIdentity splits company/partner tail', () => {
  const result = lib.parsePolishScPartnerIdentity('NET-KONT@KT S.C. Dariusz Koper Andrzej Nowak');
  assert.equal(result.name, 'NET-KONT@KT S.C');
  assert.equal(result.knownAs, 'Dariusz Koper Andrzej Nowak');
});

test('looksLikePersonalNameShape', () => {
  assert.equal(lib.looksLikePersonalNameShape('Edwin Raymundo Hernandez'), true);
  assert.equal(lib.looksLikePersonalNameShape('Acme Network Solutions'), false); // disqualifying word
});

test('parseParenthesizedTradeNameIdentity', async (t) => {
  await t.test('splits person/trade-name for an allow-listed country (GT)', () => {
    const result = lib.parseParenthesizedTradeNameIdentity(
      'EDWIN RAYMUNDO HERNANDEZ PEC (IMPORTADORA Y EXPORTADORA INTERCEL)',
      'GT',
    );
    assert.equal(result.name, 'IMPORTADORA Y EXPORTADORA INTERCEL');
    assert.equal(result.knownAs, 'EDWIN RAYMUNDO HERNANDEZ PEC');
  });

  await t.test('does not split for a non-allow-listed country', () => {
    const result = lib.parseParenthesizedTradeNameIdentity('Acme Corp (Brazil)', 'BR');
    assert.equal(result.name, 'Acme Corp (Brazil)');
    assert.equal(result.knownAs, '');
  });

  await t.test('does not split when the pre-parenthesis text looks corporate, even in GT', () => {
    const result = lib.parseParenthesizedTradeNameIdentity('Acme Networks Group (Trade Name)', 'GT');
    assert.equal(result.knownAs, '');
  });
});

test('parseOrganizationNameIdentity', async (t) => {
  await t.test('threads a trading-as split through with fullName preserved', () => {
    const result = lib.parseOrganizationNameIdentity('Remzi Toker trading as VENTURESDC');
    assert.equal(result.name, 'VENTURESDC');
    assert.equal(result.knownAs, 'Remzi Toker');
    assert.equal(result.fullName, 'Remzi Toker trading as VENTURESDC');
  });

  await t.test('a plain name with no split has empty knownAs/fullName', () => {
    const result = lib.parseOrganizationNameIdentity('Acme Networks GmbH');
    assert.equal(result.name, 'Acme Networks GmbH');
    assert.equal(result.knownAs, '');
    assert.equal(result.fullName, '');
  });
});

test('getDeterministicNetworkFallbackName', () => {
  assert.equal(lib.getDeterministicNetworkFallbackName(12345, 42, ' #42'), 'Network 42 #42');
  assert.equal(lib.getDeterministicNetworkFallbackName(null, 7), 'Network 7');
});

test('compactEntityNameWithLongNameFallback', async (t) => {
  await t.test('strips a trailing "AS<digits>" tag and the legal suffix, keeping Long Name', () => {
    const result = lib.compactEntityNameWithLongNameFallback('Cogeco Connexion Inc. AS27168');
    assert.equal(result.shortName, 'Cogeco Connexion');
    assert.equal(result.longName, 'Cogeco Connexion Inc.');
  });

  await t.test('comma-separated non-alias parts use the first legal-form part as full name', () => {
    const result = lib.compactEntityNameWithLongNameFallback('V D C Net Company Limited, Ultra Net');
    assert.equal(result.shortName, 'V D C Net Company');
    assert.equal(result.longName, 'V D C Net Company Limited');
  });

  await t.test('empty input returns empty shortName/longName', () => {
    assert.deepStrictEqual(lib.compactEntityNameWithLongNameFallback(''), { shortName: '', longName: '' });
  });
});

test('pickPreferredNetworkNameCandidate skips a bare-ASN candidate', () => {
  assert.equal(
    lib.pickPreferredNetworkNameCandidate(['AS12345', 'Acme Networks Inc.']),
    'Acme Networks',
  );
  assert.equal(lib.pickPreferredNetworkNameCandidate([]), '');
});

test('known discrepancy: pickPreferredNetworkNameCandidate does not reliably skip single-dash handle names', () => {
  // compactEntityNameWithLongNameFallback normalizes a simple single-dash
  // alphabetic candidate ("VIPY-MNT") to spaced words ("VIPY MNT") *before*
  // isLikelyGeneratedHandleName runs its check -- but that check's own
  // regexes expect the original dashed form (...-MNT, ...-AS, etc.), so the
  // now-space-separated "VIPY MNT" no longer matches and slips through as
  // if it were a real name. Locking in current behavior, not correctness.
  assert.equal(
    lib.pickPreferredNetworkNameCandidate(['VIPY-MNT', 'Acme Networks Inc.']),
    'VIPY MNT',
  );
});
