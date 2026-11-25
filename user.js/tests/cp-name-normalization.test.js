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
    'isKnownAsContainedInNames',
    'isKnownAsLegalFormOfNames',
    'isSameNameText',
    'sanitizeRdapOrgName',
    'stripRirNoticeText',
    'parseRdapTradingAsIdentity',
    'parsePolishScPartnerIdentity',
    'looksLikePersonalNameShape',
    'parseParenthesizedTradeNameIdentity',
    'looksLikeShortPersonalName',
    'parseCommaPersonTradeNameIdentity',
    'parseOrganizationNameIdentity',
    'isKnownAsFromLongNameIdentity',
    'extractRdapImportedOrgNameParts',
    'parseRdapRemarkJoinedIdentity',
    'stripTurkishSectorDescriptorTail',
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

  await t.test('the "Trade Me" exception survives an outer legal suffix', () => {
    // Regression: the guard used to compare the *input* only, so it held for
    // the bare name and evaporated on the commoner registered form -- the
    // first pass stripped "Limited" and the second ate "Me" as Brazil's ME.
    assert.equal(lib.stripCompanyTypeSuffix('Trade Me Limited'), 'Trade Me');
    assert.equal(lib.stripCompanyTypeSuffix('Trade Me Ltd.'), 'Trade Me');
  });

  await t.test('a pathologically long name returns immediately, unchanged', () => {
    // Regression: several patterns here pair a lazy group with a separator
    // class and backtrack quadratically -- a separator-dense 6400-char name
    // measured ~1.9s, and these strings arrive verbatim from third-party
    // RDAP records. Timing is asserted loosely (a 200x margin over the
    // measured cost) so this fails on a reintroduced blowup, not on a slow
    // CI runner.
    const pathological = 'A.-, '.repeat(4000); // 20,000 chars
    const started = Date.now();
    assert.equal(lib.stripCompanyTypeSuffix(pathological), pathological.trim());
    assert.ok(
      Date.now() - started < 200,
      `stripCompanyTypeSuffix took ${Date.now() - started}ms on a 20k-char name`,
    );
  });

  await t.test('the length guard does not disturb realistic names', () => {
    // 200 chars is far above any real legal name; confirm a long-but-plausible
    // one still normalizes rather than being waved through by the guard.
    const longButReal = `${'Global Interconnection Services '.repeat(4).trim()} GmbH`;
    assert.ok(longButReal.length < 200);
    assert.equal(lib.stripCompanyTypeSuffix(longButReal).endsWith('GmbH'), false);
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

// RIPE emits whois notices as RDAP remarks, and PeeringDB's org creation appended
// them to the registrant name (org 44990 / net 43269, org 45297).
const TAHA_NOTICE = "Taha Yasin Arkadas, Abuse contact for 'AS218983' is 'abuse@jetguard.co'"
  + 'Abuse-mailbox validation failed. Please refer to ORG-LCTL2-RIPE for further information';
const NERDPITCH_NOTICE = "Lorenzo Karel trading as Nerdpitch, Abuse contact for 'AS209131' is "
  + "'abuse@nerdpitch.cloud'\nAbuse-mailbox validation failed. Please refer to ORG-IG165-RIPE "
  + 'for further information.';

test('stripRirNoticeText cuts RIPE abuse notices and remarks', () => {
  assert.equal(lib.stripRirNoticeText(TAHA_NOTICE), 'Taha Yasin Arkadas');
  assert.equal(lib.stripRirNoticeText(NERDPITCH_NOTICE), 'Lorenzo Karel trading as Nerdpitch');
  assert.equal(
    lib.stripRirNoticeText('Foo Ltd\nAbuse-mailbox validation failed. Please refer to ORG-X'),
    'Foo Ltd',
  );
  assert.equal(lib.stripRirNoticeText('Name, remarks: GARBAGE'), 'Name');
  // net 44122 / org 45850 (AS207858): first RIPE remark line is a section banner.
  assert.equal(lib.stripRirNoticeText('Given Surname, ==== IPv4 ===='), 'Given Surname');
  assert.equal(lib.stripRirNoticeText('Foo Ltd, -- AS35320 ETT--'), 'Foo Ltd');
  assert.equal(lib.stripRirNoticeText('Foo Ltd, ####'), 'Foo Ltd');
});

test('stripRirNoticeText leaves real names alone', () => {
  assert.equal(lib.stripRirNoticeText('Abuse Networks Ltd'), 'Abuse Networks Ltd');
  assert.equal(lib.stripRirNoticeText('Foo-Bar Ltd, Berlin'), 'Foo-Bar Ltd, Berlin');
  assert.equal(lib.stripRirNoticeText('A+ Networks, -'), 'A+ Networks, -'); // single dash
  assert.equal(lib.stripRirNoticeText('Anti-Abuse Contact Ltd'), 'Anti-Abuse Contact Ltd');
  // Nothing would be left before the marker, so the input is kept.
  assert.equal(lib.stripRirNoticeText("Abuse contact for 'AS1' is 'x'"), "Abuse contact for 'AS1' is 'x'");
});

test('RIR notice text never reaches Name or Long Name', () => {
  assert.deepStrictEqual(
    lib.compactEntityNameWithLongNameFallback(TAHA_NOTICE),
    { shortName: 'Taha Yasin Arkadas', longName: '' },
  );
  assert.equal(lib.sanitizeRdapOrgName(TAHA_NOTICE), 'Taha Yasin Arkadas');
  assert.deepStrictEqual(
    lib.parseOrganizationNameIdentity(NERDPITCH_NOTICE, 'NL'),
    { name: 'Nerdpitch', knownAs: 'Lorenzo Karel', fullName: 'Lorenzo Karel trading as Nerdpitch' },
  );
});

// Russian/Kazakh/Uzbek legal forms written in Cyrillic, or with Cyrillic look-alike
// letters mixed in (net 43285, AS39231: AKA 'ООО "Digital-Tel Net"').
test('Cyrillic legal forms are stripped from the short Name', () => {
  const cases = [
    ['ООО "Digital-Tel Net"', 'Digital-Tel Net'],
    ['OОO "Mixed"', 'Mixed'],
    ['ТОО "Kazakh Net"', 'Kazakh Net'],
    ['ЗАО "Foo"', 'Foo'],
    ['ПАО "Ростелеком"', 'Ростелеком'],
    ['ИП Иванов Иван', 'Иванов Иван'],
    ['ЧП Петренко', 'Петренко'],
    ['"Uz Net" МЧЖ', 'Uz Net'],
    ['"Uz Net" ХК', 'Uz Net'],
  ];
  for (const [input, shortName] of cases) {
    assert.equal(lib.compactEntityNameWithLongNameFallback(input).shortName, shortName, input);
  }
});

test('Cyrillic names without a legal form are unchanged', () => {
  for (const name of ['Ташкент', 'Ромашка', 'Озон', 'Опора Телеком', 'Хакасия Net', 'Ипотека Банк']) {
    assert.deepStrictEqual(lib.compactEntityNameWithLongNameFallback(name), { shortName: name, longName: '' }, name);
  }
});

test('isKnownAsLegalFormOfNames detects an AKA that only adds a legal form', () => {
  assert.equal(lib.isKnownAsLegalFormOfNames('ООО "Digital-Tel Net"', 'Digital-Tel Net', '"Digital-Tel Net" Ltd'), true);
  assert.equal(lib.isKnownAsLegalFormOfNames('OOO "Digital-Tel Net"', 'Digital-Tel Net', ''), true);
  assert.equal(lib.isKnownAsLegalFormOfNames('OOO "Other"', 'Digital-Tel Net', ''), false);
  assert.equal(lib.isKnownAsLegalFormOfNames('Jet Guard', 'Taha Yasin Arkadas', ''), false);
  assert.equal(lib.isKnownAsLegalFormOfNames('Foo Group', 'Foo', 'Foo Ltd'), false);
  assert.equal(lib.isKnownAsLegalFormOfNames('', 'Foo'), false);
});

// Icelandic legal forms (net 43444, AS219430: "Photon ehf").
test('Icelandic legal forms are stripped from the short Name', () => {
  const cases = [
    ['Photon ehf', 'Photon'],
    ['Photon ehf.', 'Photon'],
    ['PHOTON EHF', 'PHOTON'],
    ['Photon e.h.f.', 'Photon'],
    ['Síminn hf.', 'Síminn'],
    ['Foo slf.', 'Foo'],
    ['Bar sf.', 'Bar'],
    ['Baz ses.', 'Baz'],
  ];
  for (const [input, shortName] of cases) {
    assert.deepStrictEqual(
      lib.compactEntityNameWithLongNameFallback(input),
      { shortName, longName: input },
      input,
    );
  }
});

test('short Icelandic forms only match lowercase, as the last word', () => {
  for (const name of ['Foo SF', 'Net HF', 'Ses Networks', 'Sesame', 'Gehf Net', 'Mehf']) {
    assert.deepStrictEqual(lib.compactEntityNameWithLongNameFallback(name), { shortName: name, longName: '' }, name);
  }
});

// Org 45185 repeats "Flynet BD Dot Com" in Name, Long Name and AKA.
test('isSameNameText compares names ignoring case and spacing', () => {
  assert.equal(lib.isSameNameText('Flynet BD Dot Com', 'Flynet BD Dot Com'), true);
  assert.equal(lib.isSameNameText(' flynet  bd dot com ', 'Flynet BD Dot Com'), true);
  assert.equal(lib.isSameNameText('Flynet BD Dot Com Ltd', 'Flynet BD Dot Com'), false);
  assert.equal(lib.isSameNameText('', ''), false);
  assert.equal(lib.isSameNameText('', 'Flynet'), false);
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

test('sanitizeRdapOrgName only honors an anchored trading-as marker', () => {
  // Regression: the extraction regex was unanchored, so "dba" matched at the
  // start of a string or in the middle of a word and the org name lost
  // everything before it. The anchored form below mirrors the correct twin in
  // parseRdapTradingAsIdentity.
  assert.equal(lib.sanitizeRdapOrgName('DBA Systems Inc'), 'DBA Systems Inc');
  assert.equal(lib.sanitizeRdapOrgName('Sundba Media Group'), 'Sundba Media Group');
  assert.equal(lib.sanitizeRdapOrgName('T/A Networks Limited'), 'T/A Networks Limited');
  // A genuine trading-as name must still resolve to the trading name.
  assert.equal(lib.sanitizeRdapOrgName('Remzi Toker trading as VENTURESDC'), 'VENTURESDC');
  assert.equal(lib.sanitizeRdapOrgName('Jane Roe dba Acme Networks'), 'Acme Networks');
});

test('parsePolishScPartnerIdentity requires a company before the S.C. marker', () => {
  // Regression: a lazy leading group let a *prefix* S.C. match with nothing
  // before it, so Romania's "Societate Comerciala" prefix was read as a Polish
  // civil partnership and the whole name collapsed to "S.C".
  const romanian = lib.parsePolishScPartnerIdentity('S.C. Digital Cable Systems Romania SRL');
  assert.equal(romanian.name, 'S.C. Digital Cable Systems Romania SRL');
  assert.equal(romanian.knownAs, '');

  // Same input through the dispatcher that CP actually calls.
  const viaDispatcher = lib.parseOrganizationNameIdentity('S.C. Digital Cable Systems Romania SRL');
  assert.equal(viaDispatcher.name, 'S.C. Digital Cable Systems Romania SRL');
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

test('looksLikeShortPersonalName', () => {
  assert.equal(lib.looksLikeShortPersonalName('Given Surname'), true);
  assert.equal(lib.looksLikeShortPersonalName("Jean-Luc O'Brien"), true);
  assert.equal(lib.looksLikeShortPersonalName('GIVEN SURNAME'), true);
  assert.equal(lib.looksLikeShortPersonalName('Given'), false); // one word
  assert.equal(lib.looksLikeShortPersonalName('Acme Networks'), false); // business word
  assert.equal(lib.looksLikeShortPersonalName('Smith Family'), false); // business word
  assert.equal(lib.looksLikeShortPersonalName('EXAMPLE BILISIM TEKNOLOJILERI'), false); // Turkish sector words
  assert.equal(lib.looksLikeShortPersonalName('Example Telekom'), false);
  assert.equal(lib.looksLikeShortPersonalName('Foo Ltd'), false); // legal form
  assert.equal(lib.looksLikeShortPersonalName('John Smith 2'), false); // digit
  assert.equal(lib.looksLikeShortPersonalName('john smith'), false); // not capitalized
});

test('parseCommaPersonTradeNameIdentity', async (t) => {
  await t.test('person, then trade name sharing the surname (net 43561 / org 45283 shape)', () => {
    assert.deepEqual(
      lib.parseCommaPersonTradeNameIdentity('Given Surname, Súrname Digital Solutions'),
      { name: 'Súrname Digital Solutions', knownAs: 'Given Surname' },
    );
  });

  await t.test('splits when the trade name has a legal form or business word', () => {
    assert.deepEqual(
      lib.parseCommaPersonTradeNameIdentity('Given Surname, Example IT AB'),
      { name: 'Example IT AB', knownAs: 'Given Surname' },
    );
  });

  for (const name of [
    'Acme Networks, Berlin', // company, city
    'Foo Ltd, Bar', // legal form on the left
    'John Smith, Jane Doe', // two people
    'Given Surname, Berlin', // person, city
    'John Smith, iFog', // person, unrelated remark
    'Given Surname, Súrname Digital, Berlin', // three parts
    'EXAMPLE BILISIM TEKNOLOJILERI, Brand NET Telekomunikasyon', // Turkish company, not a person
  ]) {
    await t.test(`does not split ${JSON.stringify(name)}`, () => {
      assert.equal(lib.parseCommaPersonTradeNameIdentity(name).knownAs, '');
    });
  }
});

test('isKnownAsFromLongNameIdentity', () => {
  assert.equal(
    lib.isKnownAsFromLongNameIdentity('Given Surname', 'Given Surname, Súrname Digital Solutions'),
    true,
  );
  assert.equal(
    lib.isKnownAsFromLongNameIdentity('remzi toker', 'Remzi Toker trading as VENTURESDC'),
    true,
  );
  assert.equal(lib.isKnownAsFromLongNameIdentity('IPSCAPE', 'IPSCAPE PROVEDOR DE INTERNET'), false);
  assert.equal(lib.isKnownAsFromLongNameIdentity('', 'Remzi Toker trading as VENTURESDC'), false);
  assert.equal(lib.isKnownAsFromLongNameIdentity('Remzi Toker', ''), false);
});

test('parseOrganizationNameIdentity', async (t) => {
  await t.test('threads a trading-as split through with fullName preserved', () => {
    const result = lib.parseOrganizationNameIdentity('Remzi Toker trading as VENTURESDC');
    assert.equal(result.name, 'VENTURESDC');
    assert.equal(result.knownAs, 'Remzi Toker');
    assert.equal(result.fullName, 'Remzi Toker trading as VENTURESDC');
  });

  await t.test('threads a comma person/trade-name split through with fullName preserved', () => {
    const result = lib.parseOrganizationNameIdentity('Given Surname, Súrname Digital Solutions', 'DE');
    assert.equal(result.name, 'Súrname Digital Solutions');
    assert.equal(result.knownAs, 'Given Surname');
    assert.equal(result.fullName, 'Given Surname, Súrname Digital Solutions');
  });

  await t.test('a plain name with no split has empty knownAs/fullName', () => {
    const result = lib.parseOrganizationNameIdentity('Acme Networks GmbH');
    assert.equal(result.name, 'Acme Networks GmbH');
    assert.equal(result.knownAs, '');
    assert.equal(result.fullName, '');
  });
});

// Shape of net 44210 / org 45929 (AS50019), with placeholder names.
const REMARK_JOINED_REGISTRANT = 'EXAMPLE TELEKOM VE BILISIM TEKNOLOJILERI';
const REMARK_JOINED_BRAND = 'Brand NET Telekomunikasyon';
const REMARK_JOINED_NAME = `${REMARK_JOINED_REGISTRANT}, ${REMARK_JOINED_BRAND}`;
const vcard = (fn, kind) => ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', fn], ['kind', {}, 'text', kind]]];
const REMARK_JOINED_PAYLOAD = {
  port43: 'whois.ripe.net',
  entities: [
    { handle: 'mnt-xx-example-1', roles: ['registrant'], vcardArray: vcard('mnt-xx-example-1', 'individual') },
    { handle: 'ORG-EX1-RIPE', roles: ['registrant'], vcardArray: vcard(REMARK_JOINED_REGISTRANT, 'org') },
    { handle: 'RIPE-NCC-END-MNT', roles: ['registrant'], vcardArray: vcard('RIPE-NCC-END-MNT', 'individual') },
    { handle: 'EX1-RIPE', roles: ['administrative'], vcardArray: vcard('Example NOC', 'group') },
  ],
  remarks: [{ description: [REMARK_JOINED_BRAND] }],
};

test('extractRdapImportedOrgNameParts', async (t) => {
  await t.test('RIPE: org-kind registrant fn and the first remark line', () => {
    assert.deepEqual(lib.extractRdapImportedOrgNameParts(REMARK_JOINED_PAYLOAD), {
      registrantName: REMARK_JOINED_REGISTRANT,
      remarkLine: REMARK_JOINED_BRAND,
    });
  });

  await t.test('APNIC: only the remark titled "description"', () => {
    const payload = {
      port43: 'whois.apnic.net',
      entities: REMARK_JOINED_PAYLOAD.entities,
      remarks: [{ title: 'remarks', description: ['Other'] }, { title: 'description', description: [REMARK_JOINED_BRAND] }],
    };
    assert.equal(lib.extractRdapImportedOrgNameParts(payload).remarkLine, REMARK_JOINED_BRAND);
  });

  await t.test('other RIRs get no remark line', () => {
    const payload = { ...REMARK_JOINED_PAYLOAD, port43: 'whois.arin.net' };
    assert.equal(lib.extractRdapImportedOrgNameParts(payload).remarkLine, '');
  });

  await t.test('missing payload gives empty parts', () => {
    assert.deepEqual(lib.extractRdapImportedOrgNameParts(null), { registrantName: '', remarkLine: '' });
  });
});

test('parseRdapRemarkJoinedIdentity', async (t) => {
  const parts = { registrantName: REMARK_JOINED_REGISTRANT, remarkLine: REMARK_JOINED_BRAND };

  await t.test('splits the exact joined string into registrant and brand', () => {
    assert.deepEqual(lib.parseRdapRemarkJoinedIdentity(REMARK_JOINED_NAME, parts), {
      name: REMARK_JOINED_REGISTRANT,
      knownAs: REMARK_JOINED_BRAND,
      fullName: '',
    });
  });

  await t.test('matches a stored name already through sanitizeRdapOrgName', () => {
    const dotted = { registrantName: REMARK_JOINED_REGISTRANT, remarkLine: 'Brand Net Ltd.' };
    const result = lib.parseRdapRemarkJoinedIdentity(`${REMARK_JOINED_REGISTRANT}, Brand Net Ltd`, dotted);
    assert.equal(result.knownAs, 'Brand Net Ltd.');
  });

  await t.test('matches across case and whitespace differences', () => {
    const name = `  ${REMARK_JOINED_REGISTRANT.toLowerCase()},   ${REMARK_JOINED_BRAND}`;
    assert.equal(lib.parseRdapRemarkJoinedIdentity(name, parts).knownAs, REMARK_JOINED_BRAND);
  });

  for (const [label, name, remarkLine] of [
    ['a name RDAP did not build', 'Example Networks, Berlin', REMARK_JOINED_BRAND],
    ['an empty remark line', `${REMARK_JOINED_REGISTRANT}, `, ''],
    ['a banner remark', `${REMARK_JOINED_REGISTRANT}, ==== IPv4 ====`, '==== IPv4 ===='],
    ['a legal-alias remark', 'Example Ltd, EXAMPLE', 'EXAMPLE'],
    ['a remark with a URL', `${REMARK_JOINED_REGISTRANT}, see https://example.net`, 'see https://example.net'],
    ['a remark with an ASN', `${REMARK_JOINED_REGISTRANT}, AS65550 upstream`, 'AS65550 upstream'],
    ['a handle-like remark', `${REMARK_JOINED_REGISTRANT}, EXAMPLE-MNT`, 'EXAMPLE-MNT'],
    ['a remark repeating the short Name', `${REMARK_JOINED_REGISTRANT}, EXAMPLE`, 'EXAMPLE'],
    ['a remark contained in the registrant', `${REMARK_JOINED_REGISTRANT}, Example Telekom`, 'Example Telekom'],
  ]) {
    await t.test(`does not split ${label}`, () => {
      const registrantName = name.startsWith('Example Ltd') ? 'Example Ltd'
        : name.startsWith('Example Networks') ? 'Example Networks' : REMARK_JOINED_REGISTRANT;
      const result = lib.parseRdapRemarkJoinedIdentity(name, { registrantName, remarkLine });
      assert.equal(result.knownAs, '');
    });
  }
});

test('stripTurkishSectorDescriptorTail', async (t) => {
  await t.test('trims "ve"/"san"/"tic" only next to a Turkish-only word', () => {
    assert.equal(lib.stripTurkishSectorDescriptorTail('Example Bilisim San Tic'), 'Example');
  });

  await t.test('trims a Turkish sector tail', () => {
    assert.equal(lib.stripTurkishSectorDescriptorTail(REMARK_JOINED_REGISTRANT), 'EXAMPLE');
    assert.equal(lib.stripTurkishSectorDescriptorTail('Örnek Bilişim Hizmetleri'), 'Örnek');
    assert.equal(lib.stripTurkishSectorDescriptorTail('Brand NET Telekomunikasyon'), 'Brand NET');
  });

  await t.test('keeps names without a Turkish-only tail word', () => {
    assert.equal(lib.stripTurkishSectorDescriptorTail('Example Telekom'), 'Example Telekom');
    assert.equal(lib.stripTurkishSectorDescriptorTail('Soluciones TIC'), 'Soluciones TIC');
    assert.equal(lib.stripTurkishSectorDescriptorTail('Example Internet VE'), 'Example Internet VE');
    assert.equal(lib.stripTurkishSectorDescriptorTail('Example San'), 'Example San');
    assert.equal(lib.stripTurkishSectorDescriptorTail('Example Internet'), 'Example Internet');
  });

  await t.test('keeps names that would be all descriptor', () => {
    assert.equal(lib.stripTurkishSectorDescriptorTail('Internet Ve Telekom'), 'Internet Ve Telekom');
  });

  await t.test('compact: short Name is trimmed, Long Name keeps the full name', () => {
    assert.deepEqual(lib.compactEntityNameWithLongNameFallback(REMARK_JOINED_REGISTRANT), {
      shortName: 'EXAMPLE',
      longName: REMARK_JOINED_REGISTRANT,
    });
  });

  await t.test('compact: names with a legal form are not trimmed', () => {
    assert.equal(
      lib.compactEntityNameWithLongNameFallback('Example Bilisim Teknolojileri AS').shortName,
      'Example Bilisim Teknolojileri',
    );
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
