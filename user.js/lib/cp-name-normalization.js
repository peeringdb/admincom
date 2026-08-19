// Org/RDAP name-normalization helpers for the CP consolidated userscript.
//
// This is a source fragment, not a standalone script: it is inlined into
// peeringdb-cp-consolidated-tools.user.js by scripts/build_userscripts.py at
// the `/* @include cp-name-normalization.js */` marker in that script's
// .src.js. Edit this file, then re-run the build script -- do not hand-edit
// the generated block inside the .user.js file, your changes will be
// overwritten.
//
// Pure string-transform helpers: no DOM, storage, or network access. Used by
// the RDAP org-name fallback flow and by the network/organization name-sync
// modules elsewhere in the including script.

/**
 * Checks whether a string has balanced parentheses (every close matched by an
 * earlier open, none left dangling).
 * Purpose: Guard legal-suffix/prefix stripping below. Their separator/punctuation
 * character classes intentionally include "(" and ")" so a suffix itself wrapped in
 * parens (e.g. "Foo (Ltd)") can be stripped as a unit -- but that same class can
 * otherwise swallow a real, meaningful closing paren immediately preceding a legal
 * suffix (e.g. "Power Line (HK) Co." -> "Power Line (HK"), since nothing previously
 * distinguished "decorative punctuation around the suffix" from "part of the name".
 * @param {string} value - Candidate string.
 * @returns {boolean} True when parentheses are balanced (and never go negative).
 */
function hasBalancedParens(value) {
  let depth = 0;
  for (const ch of String(value || "")) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

// Upper bound on names this module will attempt to normalize. See the note in
// stripCompanyTypeSuffix: the legal-form patterns backtrack quadratically, and
// RDAP supplies these strings.
const MAX_NORMALIZABLE_NAME_LENGTH = 200;

// Names preserved verbatim because a legal-form pattern would otherwise eat
// part of the brand.
const KNOWN_INTACT_NAMES = new Set(["trade me"]);

/**
 * Reports whether a name must be preserved verbatim rather than suffix-stripped.
 * Purpose: Share one false-positive list between the pre-check and the strip
 * loop, so a guarded name stays guarded at every intermediate step.
 * Necessity: The loop rewrites `candidate` in place; a guard that only inspects
 * the original input silently stops applying after the first strip.
 * @ai Keep behavior stable and prefer minimal, localized edits.
 * @param {string} value - Candidate name at any point during stripping.
 * @returns {boolean} True when the name is a known false positive.
 */
function isKnownIntactName(value) {
  return KNOWN_INTACT_NAMES.has(String(value || "").trim().toLowerCase());
}

/**
 * Strips leading and trailing legal company-type prefixes and suffixes from a name.
 * Purpose: Keep network short Name concise while preserving full legal form
 * in Long Name.
 * Necessity: Organizations frequently include legal prefixes (e.g. PT, CV) and
 * suffixes (e.g. LTDA, SAS) that are better suited for Long Name than short Name.
 * @ai Keep behavior stable and prefer minimal, localized edits.
 * @param {string} name - Full organization name.
 * @returns {string} Name without leading company-type prefix or trailing suffix tokens.
 */
function stripCompanyTypeSuffix(name) {
  const original = String(name || "").trim().replace(/\s+/g, " ");
  if (!original) return "";

  // Several patterns below pair a lazy `(.*?)` with a separator character class,
  // which backtracks quadratically when the rest of the pattern cannot match.
  // Measured on a separator-dense string: 800 chars ~ 210ms, 3200 ~ 460ms,
  // 6400 ~ 1.9s -- enough to freeze the tab. Names reach this function straight
  // from third-party RDAP records, so the length is not ours to trust. No real
  // legal name approaches this bound, and returning the input unchanged is the
  // right outcome for something this long anyway.
  if (original.length > MAX_NORMALIZABLE_NAME_LENGTH) return original;

  // Known false positives: names whose tail looks like a legal suffix but isn't
  // (here "Me" parses as Brazil's ME/Microempresa). Also re-checked inside the
  // strip loop -- checking only the input meant the guard held for "Trade Me"
  // but not "Trade Me Limited", which stripped through to "Trade".
  if (isKnownIntactName(original)) return original;

  const legalSuffixPatterns = [
    "Corporation", // Corporation (US and other common-law jurisdictions)
    "Incorporated", // Incorporated (US)
    "Foundation", // Foundation (generic non-profit/foundation legal form, many jurisdictions)
    "Private\\s+Limited", // Private Limited (UK/Commonwealth: India, Singapore, Hong Kong, etc.)
    "Limited", // Limited (UK/Commonwealth)
    "Limitada", // Limitada (Spanish/Portuguese "Limited" - Latin America, Spain, Portugal, Brazil)
    "L\\.?\\s*T\\.?\\s*D\\.?\\s*A\\.?\\s*-?\\s*E\\.?\\s*P\\.?\\s*P\\.?", // LTDA-EPP (Brazil: Sociedade Limitada - Empresa de Pequeno Porte, small-business tax regime)
    "L\\.?\\s*T\\.?\\s*D\\.?\\s*A\\.?\\s*-?\\s*M\\.?\\s*E\\.?", // LTDA-ME (Brazil: Sociedade Limitada - Microempresa, micro-business tax regime)
    "E\\.?\\s*I\\.?\\s*R\\.?\\s*E\\.?\\s*L\\.?\\s*I\\.?\\s*-?\\s*M\\.?\\s*E\\.?", // EIRELI-ME (Brazil: Empresa Individual de Responsabilidade Limitada - Microempresa)
    "Limitada\\s*-?\\s*M\\.?\\s*E\\.?", // Limitada-ME (Brazil: spelled-out Limitada + Microempresa)
    "Limitada\\s*-?\\s*E\\.?\\s*P\\.?\\s*P\\.?", // Limitada-EPP (Brazil: spelled-out Limitada + Empresa de Pequeno Porte)
    "G\\.?\\s*M\\.?\\s*B\\.?\\s*H\\.?\\s*&\\s*C\\.?\\s*O\\.?\\s*K\\.?\\s*G\\.?", // GmbH & Co. KG (Germany/Austria: limited partnership with a GmbH as general partner)
    "S\\.?\\s*A\\.?\\s*de\\s*C\\.?\\s*V\\.?", // S.A. de C.V. (Mexico: Sociedad Anónima de Capital Variable)
    "S\\.?\\s*de\\s*R\\.?\\s*L\\.?\\s*de\\s*C\\.?\\s*V\\.?", // S. de R.L. de C.V. (Mexico: Sociedad de Responsabilidad Limitada de Capital Variable)
    "Unipessoal\\s+L\\.?\\s*d\\.?\\s*a\\.?", // Unipessoal Lda (Portugal: single-member limited company)
    "P\\.?\\s*v\\.?\\s*t\\.?\\s*L\\.?\\s*t\\.?\\s*d\\.?", // Pvt Ltd (India/South Asia: Private Limited)
    "S\\.?\\s*d\\.?\\s*n\\.?\\s*B\\.?\\s*h\\.?\\s*d\\.?", // Sdn Bhd (Malaysia: Sendirian Berhad - private limited company)
    "j\\.?\\s*d\\.?\\s*o\\.?\\s*o\\.?", // j.d.o.o. (Croatia: jednostavno društvo s ograničenom odgovornošću - simplified LLC)
    "E\\.?\\s*O\\.?\\s*O\\.?\\s*D\\.?", // EOOD (Bulgaria: Ednolichno Druzhestvo s Ogranichena Otgovornost - single-owner LLC)
    "L\\.?\\s*[tT]\\.?\\s*[dD]\\.?\\s*\\u015e[tT][iI\\u0130\\u0131]\\.?", // Ltd Şti (Turkey: alternate ordering of Limited Şirketi)
    "B\\.?\\s*V\\.?\\s*B\\.?\\s*A\\.?", // BVBA (Belgium, Dutch: Besloten Vennootschap met Beperkte Aansprakelijkheid - former private limited form)
    "C\\.?\\s*V\\.?\\s*B\\.?\\s*A\\.?", // CVBA (Belgium, Dutch: Coöperatieve Vennootschap met Beperkte Aansprakelijkheid - limited-liability cooperative)
    "K\\.?\\s*G\\.?\\s*a\\.?\\s*A\\.?", // KGaA (Germany: Kommanditgesellschaft auf Aktien - partnership limited by shares)
    "S\\.?\\s*A\\.?\\s*S\\.?\\s*U\\.?", // SASU (France: Société par Actions Simplifiée Unipersonnelle - single-shareholder SAS)
    "C\\.?\\s*o\\.?[,\\s]*L\\.?\\s*t\\.?\\s*d\\.?", // Co., Ltd (generic East Asia: Japan, Korea, China, Taiwan, Hong Kong)
    "S\\.?\\s*p\\.?\\s*z\\.?\\s*o\\.?\\s*o\\.?", // Sp. z o.o. (Poland: Spółka z ograniczoną odpowiedzialnością - LLC)
    "P\\.?\\s*J\\.?\\s*S\\.?\\s*C\\.?", // PJSC (Public Joint Stock Company - Russia, Ukraine, UAE and other post-Soviet/Gulf jurisdictions)
    "J\\.?\\s*S\\.?\\s*C\\.?\\s*B\\.?", // JSCB (Joint Stock Commercial Bank - Russia/Uzbekistan and other post-Soviet banks)
    "J\\.?\\s*S\\.?\\s*C\\.?", // JSC (Joint Stock Company - Russia and other post-Soviet states, generic)
    "L\\.?\\s*T\\.?\\s*D\\.?\\s*A\\.?", // LTDA (Brazil/Latin America: Sociedade/Sociedad Limitada)
    "E\\.?\\s*I\\.?\\s*R\\.?\\s*E\\.?\\s*L\\.?\\s*I\\.?", // EIRELI (Brazil: Empresa Individual de Responsabilidade Limitada - single-owner LLC)
    "E\\.?\\s*U\\.?\\s*R\\.?\\s*L\\.?", // EURL (France: Entreprise Unipersonnelle à Responsabilité Limitée - single-member LLC)
    "S\\.?\\s*A\\.?\\s*R\\.?\\s*L\\.?", // SARL (France and Francophone countries: Société à Responsabilité Limitée)
    "S\\.?\\s*A\\.?\\s*S\\.?", // SAS (France: Société par Actions Simplifiée; Colombia: Sociedad por Acciones Simplificada)
    "S\\.?\\s*P\\.?\\s*R\\.?\\s*L\\.?", // SPRL (Belgium, French: Société Privée à Responsabilité Limitée)
    "S\\.?\\s*P\\.?\\s*A\\.?", // SPA (Italy: Società per Azioni - joint-stock company)
    "S\\.?\\s*R\\.?\\s*L\\.?", // SRL (Italy: Società a Responsabilità Limitata; also Latin America: Sociedad de Responsabilidad Limitada)
    "S\\.?\\s*R\\.?\\s*O\\.?", // SRO (Czech Republic/Slovakia: Společnost s ručením omezeným - LLC)
    "S\\.?\\s*C\\.?\\s*A\\.?", // SCA (France/Belgium/Luxembourg: Société en Commandite par Actions - partnership limited by shares)
    "S\\.?\\s*N\\.?\\s*C\\.?", // SNC (France: Société en Nom Collectif; Italy: Società in Nome Collettivo - general partnership)
    "S\\.?\\s*C\\.?\\s*C\\.?", // SCC - jurisdiction/legal form not confirmed by research; kept as pre-existing pattern, verify before relying on it
    "S\\.?\\s*L\\.?\\s*U\\.?", // SLU (Spain: Sociedad Limitada Unipersonal - single-member LLC)
    "G\\.?\\s*M\\.?\\s*B\\.?\\s*H\\.?", // GmbH (Germany/Austria: Gesellschaft mit beschränkter Haftung - LLC)
    "P\\.?\\s*L\\.?\\s*L\\.?\\s*C\\.?", // PLLC (US: Professional Limited Liability Company)
    "V\\.?\\s*O\\.?\\s*F\\.?", // VOF (Netherlands: Vennootschap Onder Firma - general partnership)
    "O\\.?\\s*H\\.?\\s*G\\.?", // OHG (Germany: Offene Handelsgesellschaft - general partnership)
    "O\\.?\\s*O\\.?\\s*O\\.?", // OOO (Russia: Obshchestvo s Ogranichennoy Otvetstvennostyu - LLC)
    "P\\.?\\s*A\\.?\\s*O\\.?", // PAO (Russia: Publichnoye Aktsionernoye Obshchestvo - public joint stock company, post-2014 term)
    "P\\.?\\s*A\\.?\\s*T\\.?", // PAT (Ukraine: publichne aktsionerne tovarystvo - public joint stock company)
    "O\\.?\\s*O\\.?\\s*D\\.?", // OOD (Bulgaria: Druzhestvo s Ogranichena Otgovornost - LLC)
    "D\\.?\\s*O\\.?\\s*O\\.?", // DOO (Balkans - Croatia/Serbia/Bosnia/Slovenia: Društvo s ograničenom odgovornošću - LLC)
    "T\\.?\\s*O\\.?\\s*V\\.?", // TOV (Ukraine: tovarystvo z obmezhenoyu vidpovidalnistyu - LLC)
    "E\\.?\\s*P\\.?\\s*E\\.?", // EPE (Greece: Etaireia Periorismenis Efthinis - limited liability company)
    "I\\.?\\s*K\\.?\\s*E\\.?", // IKE (Greece: Idiotiki Kefalaiouchiki Etaireia - private capital company)
    "E\\.?\\s*P\\.?\\s*P\\.?", // EPP (Brazil: Empresa de Pequeno Porte - small-business tax regime, standalone form)
    "M\\.?\\s*E\\.?\\s*I\\.?", // MEI (Brazil: Microempreendedor Individual - individual micro-entrepreneur)
    "N\\.?\\s*y\\.?\\s*r\\.?\\s*t\\.?", // Nyrt (Hungary: Nyilvánosan működő részvénytársaság - public limited company)
    "Z\\.?\\s*r\\.?\\s*t\\.?", // Zrt (Hungary: Zártkörűen működő részvénytársaság - private limited company)
    "K\\.?\\s*f\\.?\\s*t\\.?", // Kft (Hungary: Korlátolt Felelősségű Társaság - LLC)
    "A\\.?\\s*p\\.?\\s*S\\.?", // ApS (Denmark: Anpartsselskab - private limited company)
    "A\\.?\\s*N\\.?\\s*S\\.?", // ANS (Norway: Ansvarlig Selskap - general partnership)
    "A\\.?\\s*S\\.?\\s*A\\.?", // ASA (Norway: Allmennaksjeselskap - public limited company)
    "O\\.?\\s*y\\.?\\s*j\\.?", // Oyj (Finland: julkinen osakeyhtiö - public limited company)
    "S\\.?\\s*p\\.?\\s*k\\.?", // Spk (Poland: Sp.k. / spółka komandytowa - limited partnership)
    "S\\.?\\s*p\\.?\\s*j\\.?", // Spj (Poland: Sp.j. / spółka jawna - general partnership)
    "d\\.?\\s*o\\.?\\s*o\\.?", // doo (Balkans lowercase variant of DOO above - LLC)
    "L\\.?\\s*d\\.?\\s*a\\.?", // Lda (Portugal: lowercase Limitada abbreviation)
    "U\\.?\\s*A\\.?\\s*B\\.?", // UAB (Lithuania: Uždaroji akcinė bendrovė - private limited company)
    "S\\.?\\s*I\\.?\\s*A\\.?", // SIA (Latvia: Sabiedrība ar ierobežotu atbildību - LLC)
    "Z\\.?\\s*A\\.?\\s*O\\.?", // ZAO (Russia: Zakrytoye Aktsionernoye Obshchestvo - closed joint stock company, pre-2014 term)
    "L\\.?\\s*T\\.?\\s*D\\.?", // LTD (generic Commonwealth/international: Limited)
    "L\\.?\\s*L\\.?\\s*C\\.?", // LLC (US and international: Limited Liability Company)
    "L\\.?\\s*L\\.?\\s*P\\.?", // LLP (US/UK: Limited Liability Partnership)
    "I\\.?\\s*N\\.?\\s*C\\.?", // INC (US: Incorporated)
    "P\\.?\\s*L\\.?\\s*C\\.?", // PLC (UK: Public Limited Company)
    "P\\.?\\s*T\\.?\\s*E\\.?", // PTE (Singapore: Private, used as "Pte Ltd")
    "P\\.?\\s*T\\.?\\s*Y\\.?", // PTY (Australia/South Africa: Proprietary, used as "Pty Ltd")
    "L\\.?\\s*P\\.?", // LP (US/UK: Limited Partnership)
    "A\\.?\\s*G\\.?", // AG (Germany/Switzerland/Austria: Aktiengesellschaft - stock corporation)
    "K\\.?\\s*G\\.?", // KG (Germany/Austria: Kommanditgesellschaft - limited partnership)
    "U\\.?\\s*G\\.?", // UG (Germany: Unternehmergesellschaft - low-capital "mini-GmbH")
    "O\\.?\\s*G\\.?", // OG (Austria: Offene Gesellschaft - general partnership)
    "G\\.?\\s*b\\.?\\s*R\\.?", // GbR (Germany: Gesellschaft bürgerlichen Rechts - civil law partnership)
    "e\\.?\\s*V\\.?", // eV (Germany: eingetragener Verein - registered association)
    "e\\.?\\s*K\\.?", // eK (Germany: eingetragener Kaufmann - registered sole trader)
    "e\\.?\\s*G\\.?", // eG (Germany: eingetragene Genossenschaft - registered cooperative)
    "m\\.?\\s*b\\.?\\s*H\\.?", // mbH (Germany/Austria: standalone "mit beschränkter Haftung" fragment of GmbH)
    "B\\.?\\s*V\\.?", // BV (Netherlands: Besloten Vennootschap - private limited company)
    "N\\.?\\s*V\\.?", // NV (Netherlands/Belgium: Naamloze Vennootschap - public limited company)
    "C\\.?\\s*V\\.?", // CV (Netherlands: Commanditaire Vennootschap - limited partnership)
    "A\\.?\\s*B\\.?", // AB (Sweden: Aktiebolag - limited company)
    "H\\.?\\s*B\\.?", // HB (Sweden: Handelsbolag - general/trading partnership)
    "K\\.?\\s*B\\.?", // KB (Sweden: Kommanditbolag - limited partnership)
    "O\\.?\\s*y\\.?", // Oy (Finland: Osakeyhtiö - limited company)
    "A\\/S", // A/S (Denmark/Norway: Aktieselskab - stock company)
    "K\\/S", // K/S (Denmark: Kommanditselskab - limited partnership)
    "I\\/S", // I/S (Denmark: Interessentskab - general partnership)
    // E.A.S. / EAS (Paraguay: Empresa por Acciones Simplificadas). Listed before the
    // bare "A.?S.?" (Nordic A/S) pattern below so the full 3-letter form strips as one
    // unit; without it, "A.?S.?" alone still matches the "A.S" tail of "Foo E.A.S" and
    // leaves a dangling "E" attached to the short name (e.g. "Foo E" instead of "Foo").
    "E\\.?\\s*A\\.?\\s*S\\.?", // EAS (Paraguay: Empresa por Acciones Simplificadas)
    "A\\.?\\s*S\\.?", // A.S. / AS (Turkey: Anonim Şirket; also dotted form of Nordic A/S above)
    "A\\.?\\s*O\\.?", // A.O. (Russia: Aktsionernoye Obshchestvo - joint stock company, unified post-2014 term)
    "K\\.?\\s*K\\.?", // K.K. (Japan: Kabushiki Kaisha - stock company)
    "G\\.?\\s*K\\.?", // G.K. (Japan: Godo Kaisha - Japanese LLC-equivalent)
    "P\\.?\\s*v\\.?\\s*t\\.?", // P.v.t. (India: dotted "Pvt" fragment - Private, standalone fallback without Ltd)
    "B\\.?\\s*h\\.?\\s*d\\.?", // B.h.d. (Malaysia: dotted "Bhd" fragment - Berhad, standalone fallback without Sdn)
    "B\\.?\\s*t\\.?", // B.t. (Hungary: dotted Bt - betéti társaság, limited partnership)
    "d\\.?\\s*d\\.?", // d.d. (Croatia/Slovenia: dioničko društvo / delniška družba - joint stock company)
    "C\\.?\\s*o\\.?\\s*r\\.?\\s*p\\.?", // C.o.r.p. (dotted abbreviated form of "Corp" - Corporation)
    "C\\.?\\s*C\\.?", // C.C. - jurisdiction/legal form not confirmed by research; kept as pre-existing pattern, verify before relying on it
    "S[a\\u00e0]rl", // Sàrl (Switzerland, French-speaking cantons: accented variant of SARL)
    "A\\.?\\s*\\u015e\\.?", // A.Ş. (Turkey: Anonim Şirket, accented Turkish spelling)
    "A\\.?\\s*D\\.?", // A.D. (Bulgaria/North Macedonia/Serbia: Akcionersko Druzhestvo / Akcionarsko Društvo - joint stock company)
    "A\\.?\\s*E\\.?", // A.E. (Greece: Anonymi Etaireia - societe anonyme / joint stock company)
    "O\\.?\\s*E\\.?", // O.E. (Greece: Omorrythmos Etaireia - general partnership)
    "E\\.?\\s*E\\.?", // E.E. (Greece: Eterorrythmos Etaireia - limited partnership)
    "P\\.?\\s*P\\.?", // P.P. - jurisdiction/legal form not confirmed by research; kept as pre-existing pattern, verify before relying on it
    "a\\.?\\s*s\\.?", // a.s. (Czech Republic/Slovakia: akciová společnost - joint stock company; lowercase distinguishes from Nordic AS)
    "O[\\u00dc\\u00fc]|OU", // OÜ / OU (Estonia: Osaühing - private limited company)
    "S\\.?\\s*E\\.?", // S.E. (EU-wide: Societas Europaea - European public company)
    "M\\.?\\s*B\\.?", // M.B. - jurisdiction/legal form not confirmed by research; kept as pre-existing pattern, verify before relying on it
    "S\\.?\\s*A\\.?", // S.A. (generic: Sociedad/Société/Società Anónima/Anonyme - Spain, France, Latin America, Switzerland, Belgium, Greece, etc.)
    "S\\.?\\s*L\\.?", // S.L. (Spain: Sociedad Limitada - limited company)
    "S\\.?\\s*C\\.?", // S.C. (Poland: spółka cywilna - civil law partnership; also used generically for "société civile"-style forms elsewhere)
    "C\\.?\\s*A\\.?", // C.A. (Venezuela: Compañía Anónima - joint stock company)
    "C\\.?\\s*O\\.?", // C.O. (generic dotted abbreviation of "Co." - Company; not tied to a specific jurisdiction)
    "S\\.?\\s*S\\.?", // S.S. - jurisdiction/legal form not confirmed by research; kept as pre-existing pattern, verify before relying on it
    "M\\.?\\s*E\\.?", // M.E. (Brazil: Microempresa - micro-business tax regime, standalone form)
  ];

  const legalPrefixPatterns = [
    "P\\.?\\s*T\\.?", // PT / P.T. (Indonesia)
    "C\\.?\\s*V\\.?", // CV / C.V. (Indonesia)
    "U\\.?\\s*D\\.?", // UD / U.D. (Indonesia)
    "P\\.?\\s*D\\.?", // PD / P.D. (Indonesia)
    "T\\.?\\s*O\\.?\\s*O\\.?", // TOO / T.O.O. (Kazakhstan)
    "O\\.?\\s*O\\.?\\s*O\\.?", // OOO / O.O.O. (Russia)
    "O\\.?\\s*A\\.?\\s*O\\.?", // OAO / O.A.O. (Russia)
    "E\\.?\\s*O\\.?\\s*O\\.?\\s*D\\.?", // EOOD / E.O.O.D. (Bulgaria)
    "O\\.?\\s*O\\.?\\s*D\\.?", // OOD / O.O.D. (Bulgaria)
    "SPOLKA\\s+JAWNA", // Spolka Jawna (Polish general partnership)
    "SP\\.?\\s*J\\.?", // Sp. J. (Polish general partnership)
    "N\\.?\\s*V\\.?", // NV / N.V.
    "E\\.?\\s*V\\.?", // e.V. / EV (Germany: eingetragener Verein)
    "EINGETRAGENER\\s+VEREIN", // Eingetragener Verein (Germany)
    "I\\.?\\s*K\\.?\\s*E\\.?", // IKE / I.K.E. (Greece)
    "PRIVATE\\s+ENTERPRISE", // Private Enterprise (common legal form label)
    "F\\.?\\s*O\\.?\\s*P\\.?", // FOP / F.O.P. (Ukraine: sole proprietor)
    "FIZYCHNA\\s+OSOBA\\s+PIDPRYYEMETS", // Full transliterated FOP legal form (Ukraine)
    "PRIVATELY\\s+OWNED\\s+ENTREPRENEUR", // Privately owned entrepreneur (sole proprietor legal form)
    "AKTSIONERNO\\s+DRUZHESTVO", // Aktsionerno Druzhestvo (Bulgarian joint-stock company)
    "K\\.?\\s*K\\.?", // K.K. / KK (Japan: Kabushiki Kaisha)
    "Z\\.?\\s*S\\.?", // z.s. / zs (Czech: zapsany spolek, registered association)
    "LIMITED\\s+LIABILITY\\s+COMPANY", // Limited Liability Company (full legal form)
    "PUBLIC\\s+JOINT[-\\s]+STOCK\\s+COMPANY", // Public Joint Stock Company (full legal form)
    "OPEN\\s+JOINT[-\\s]+STOCK\\s+COMPANY", // Open Joint Stock Company (full legal form)
    "P\\.?\\s*J\\.?\\s*S\\.?\\s*C\\.?", // PJSC / P.J.S.C.
    "O\\.?\\s*J\\.?\\s*S\\.?\\s*C\\.?", // OJSC / O.J.S.C.
    "J\\.?\\s*C\\.?\\s*S\\.?", // JCS / J.C.S.
    "J\\.?\\s*S\\.?\\s*C\\.?", // JSC / J.S.C.
    "S\\.?\\s*R\\.?\\s*L\\.?\\s*S\\.?", // SRLS / S.R.L.S.
    "CLOSED\\s+JOINT[-\\s]+STOCK\\s+COMPANY", // Closed Joint Stock Company (full legal form)
    "C\\.?\\s*J\\.?\\s*S\\.?\\s*C\\.?", // CJSC / C.J.S.C. (Closed Joint-Stock Company)
    "M\\.?\\s*\\/\\s*S\\.?", // M/S. / M/s. (South Asia, "Messrs.")
    "L\\.?\\s*L\\.?\\s*C\\.?", // LLC / L.L.C. when used as a leading legal designator
    "UAB", // UAB (Lithuania: Uzdaroji akcine bendrove, private limited company)
    "O\\.?\\s*U\\.?", // OU (Estonia: Osaühing)
    "O\\.?\\s*Y\\.?", // OY (Finland: Osakeyhtiö)
    // Limited Şirketi (Turkey: Limited Company). "İ" (U+0130, dotted capital I) is a
    // distinct Unicode character from plain "I"/"i" -- not a case-fold pair -- so a
    // literal "İ" only ever matches an all-caps Turkish legal-register rendering.
    // Ordinary mixed-case text ("Limited Şirketi") spells those same letters as plain
    // ASCII "i", which the bare literal below would silently reject. [İIi] tolerates
    // both.
    "L[İIi]M[İIi]TED\\s+Ş[İIi]RKET[İIi]",
    // ASCII-transliterated spelling of the same Turkish legal form: "Ş" (U+015E) itself
    // replaced by plain "S", as commonly seen in RDAP/RIPE data (e.g. "AnatoliaCore
    // Teknoloji Limited Sirketi", AS219349). Without this, the name never gets recognized
    // as having a legal suffix at all, which also stops
    // resolveCompactNameFromCommaLegalAliases() from collapsing a duplicate
    // "Name Ltd Sirketi, NAME" alias pair into one clean name.
    "LIMITED\\s+SIRKETI", // Limited Sirketi (Turkey: fully ASCII spelling of Limited Şirketi)
    "A\\.?\\s*Ş\\.?", // A.Ş. (Turkey: Anonim Şirket - Joint Stock Company)
  ];

  const suffixRegex = new RegExp(
    `(?:[\\s,()._-]+)(?:${legalSuffixPatterns.join("|")})\\.?[\\s,()._-]*$`,
    "i",
  );
  const prefixRegex = new RegExp(
    `^(?:${legalPrefixPatterns.join("|")})\\.?[\\s,._-]+`,
    "i",
  );
  const trailingPrefixRegex = new RegExp(
    `(?:[\\s,()._-]+)(?:${legalPrefixPatterns.join("|")})\\.?[\\s,()._-]*$`,
    "i",
  );

  let candidate = original;
  let previous = "";
  const hadPrivatelyOwnedEntrepreneurPrefix = /^PRIVATELY\s+OWNED\s+ENTREPRENEUR\b/i.test(original);

  // Normalize names that append a location after EOOD/OOD/DOO, so legal stripping can proceed.
  // Example: "DGM EOOD, Sofia, Bulgaria" -> "DGM EOOD".
  const llcWithTrailingLocationRegex = /(.*?)(?:[\s,().-]+)((?:E\.?\s*O\.?\s*O\.?\s*D\.?)|(?:O\.?\s*O\.?\s*D\.?)|(?:D\.?\s*O\.?\s*O\.?))\b(?:[\s,.-]+[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'-]*){1,3}[\s,().-]*$/i;
  const llcWithTrailingLocationMatch = candidate.match(llcWithTrailingLocationRegex);
  if (llcWithTrailingLocationMatch?.[1] && llcWithTrailingLocationMatch?.[2]) {
    candidate = `${llcWithTrailingLocationMatch[1].trim()} ${llcWithTrailingLocationMatch[2].trim()}`.trim();
  }

  // Normalize "<name> <legal suffix> <country token>" ordering so legal stripping can proceed.
  // Example: "Phylaxis, Inc. USA" -> "Phylaxis Inc." -> "Phylaxis".
  const legalWithTrailingCountryCodeRegex = new RegExp(
    `(.*?)(?:[\\s,().-]+)((?:${legalSuffixPatterns.join("|")}))\\b(?:[\\s,.-]+)(?:[A-Z]{2}|[A-Z]{3})[\\s,().-]*$`,
    "i",
  );
  if (!suffixRegex.test(candidate)) {
    const legalWithTrailingCountryCodeMatch = candidate.match(legalWithTrailingCountryCodeRegex);
    if (legalWithTrailingCountryCodeMatch?.[1] && legalWithTrailingCountryCodeMatch?.[2]) {
      candidate = `${legalWithTrailingCountryCodeMatch[1].trim()} ${legalWithTrailingCountryCodeMatch[2].trim()}`.trim();
    }
  }

  // Strip leading prefix once
  candidate = candidate.replace(prefixRegex, "").trim();

  // Strip trailing suffixes (may be multiple layers)
  while (candidate && candidate !== previous && suffixRegex.test(candidate)) {
    // Re-check every layer: "Trade Me Limited" reaches "Trade Me" here, and
    // without this the next pass strips "Me" as a Brazilian ME suffix.
    if (isKnownIntactName(candidate)) break;
    previous = candidate;
    const stripped = candidate.replace(suffixRegex, "").trim().replace(/[\s,().-]+$/g, "").trim();
    // Reject a strip that orphans a real "(" that was balanced before this step --
    // see hasBalancedParens() above for why the separator class can do this.
    if (!hasBalancedParens(candidate) || hasBalancedParens(stripped)) {
      candidate = stripped;
    }
  }

  // Strip trailing prefix-type legal tokens when source ordering is reversed
  // (e.g. "Company PT" instead of "PT Company").
  previous = "";
  while (candidate && candidate !== previous && trailingPrefixRegex.test(candidate)) {
    previous = candidate;
    const stripped = candidate.replace(trailingPrefixRegex, "").trim().replace(/[\s,().-]+$/g, "").trim();
    if (!hasBalancedParens(candidate) || hasBalancedParens(stripped)) {
      candidate = stripped;
    }
  }

  // For "Privately owned entrepreneur ..." names, drop trailing ISO country code tails.
  // Example: "Example Person Name, UA" -> "Example Person Name".
  if (hadPrivatelyOwnedEntrepreneurPrefix) {
    candidate = candidate.replace(/(?:[\s,()._-]+)[A-Z]{2}\.?[\s,()._-]*$/, "").trim();
  }

  // Strip Bulgarian "AD" legal form (Aktsionerno Druzhestvo) in uppercase form only.
  // Case-sensitive intentionally to avoid false positives with ordinary lowercase words.
  const bulgarianAdPrefixRegex = /^A\.?\s*D\.?[\s,._-]+/;
  if (bulgarianAdPrefixRegex.test(candidate)) {
    candidate = candidate
      .replace(bulgarianAdPrefixRegex, "")
      .trim()
      .replace(/[\s,().-]+$/g, "")
      .trim();
  }

  const bulgarianAdSuffixRegex = /(?:[\s,()._-]+)A\.?\s*D\.?[\s,()._-]*$/;
  if (bulgarianAdSuffixRegex.test(candidate)) {
    const stripped = candidate
      .replace(bulgarianAdSuffixRegex, "")
      .trim()
      .replace(/[\s,().-]+$/g, "")
      .trim();
    if (!hasBalancedParens(candidate) || hasBalancedParens(stripped)) {
      candidate = stripped;
    }
  }

  // Strip Scandinavian "AS" suffix (Aksjeselskap/Aktieselskab, NO/DK).
  // Case-sensitive intentionally: avoids false positives with English "as".
  // Must run after the main suffix loop so multi-layer strips have already resolved.
  const scandinavianAsSuffixRegex = /(?:[\s,().-]+)AS\.?[\s,().-]*$/;
  if (scandinavianAsSuffixRegex.test(candidate)) {
    const stripped = candidate
      .replace(scandinavianAsSuffixRegex, "")
      .trim()
      .replace(/[\s,().-]+$/g, "")
      .trim();
    if (stripped && (!hasBalancedParens(candidate) || hasBalancedParens(stripped))) {
      candidate = stripped;
    }
  }

  // Remove wrapping quotes after legal prefix/suffix stripping.
  candidate = candidate.replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/g, "").trim();

  // Keep quote behavior consistent for short-name normalization.
  // If ASCII double-quotes are unbalanced (odd count), drop all of them.
  const asciiDoubleQuoteCount = (candidate.match(/"/g) || []).length;
  if (asciiDoubleQuoteCount % 2 === 1) {
    candidate = candidate.replace(/"/g, "").replace(/\s+/g, " ").trim();
  }

  return candidate || original;
}

/**
 * Trims obvious organizational unit descriptors after a comma.
 * Purpose: Keep short Name concise when source names include department/division text.
 * Necessity: Names like "Company, Data Network Management Division" should keep
 * the unit in Long Name while using company core in Name.
 * @ai Keep behavior stable and prefer minimal, localized edits.
 * @param {string} name - Full organization/network name.
 * @returns {string} Name with trailing unit descriptor removed when confidently detected.
 */
function stripOrganizationalUnitDescriptor(name) {
  const original = String(name || "").trim().replace(/\s+/g, " ");
  if (!original || !original.includes(",")) return original;

  const parts = original
    .split(",")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (parts.length < 2) return original;

  const rightSide = parts.slice(1).join(" ").toLowerCase();
  const unitDescriptorRegex = /\b(division|department|directorate|bureau|office|branch|section|team|unit|director\s+general|ministry|province|provincial|regional)\b/i;
  const leftSide = parts[0];

  // Handle "Name, legal-form, ISP descriptor" style strings.
  // Example: "NovInvestRezerv, LLC, ISP NIR-Telecom" -> "NovInvestRezerv".
  const standaloneLegalMiddleTokenRegex = /^(?:L\.?\s*L\.?\s*C\.?|L\.?\s*L\.?\s*P\.?|L\.?\s*T\.?\s*D\.?|I\.?\s*N\.?\s*C\.?|G\.?\s*M\.?\s*B\.?\s*H\.?|S\.?\s*R\.?\s*L\.?|S\.?\s*P\.?\s*J\.?)$/i;
  const telecomDescriptorRegex = /\b(isp|telecom|telecommunications|internet\s+provider|provider)\b/i;
  if (
    parts.length >= 3
    && standaloneLegalMiddleTokenRegex.test(parts[1])
    && telecomDescriptorRegex.test(parts.slice(2).join(" "))
    && leftSide.length >= 3
  ) {
    return leftSide;
  }

  if (!unitDescriptorRegex.test(rightSide) || leftSide.length < 3) {
    return original;
  }

  return leftSide;
}

/**
 * Resolves canonical short name from comma-separated legal aliases.
 * Purpose: Handle patterns like "FOO SDN BHD, Foo Berhad" and keep one compact short name.
 * @ai Preserve normalization/parsing rules and backward-compatible output formats.
 * @param {string} name - Full organization/network name.
 * @returns {string} Canonical compact alias, or empty string when not confidently resolvable.
 */
function resolveCompactNameFromCommaLegalAliases(name) {
  const original = String(name || "").trim().replace(/\s+/g, " ");
  if (!original.includes(",")) return "";

  const parts = original
    .split(",")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (parts.length < 2) return "";

  const strippedParts = parts
    .map((part) => stripCompanyTypeSuffix(part))
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (strippedParts.length < 2) return "";

  const normalized = strippedParts.map((part) => part.toLowerCase());
  const allMatch = normalized.every((value) => value === normalized[0]);
  if (!allMatch) return "";

  const preferred = strippedParts.find((part) => /[a-z]/.test(part));
  return preferred || strippedParts[0] || "";
}

/**
 * Removes trailing registration-number segment when appended after a comma.
 * Example: "Company PTE. LTD., 202208375N" -> "Company PTE. LTD."
 * @ai Keep behavior stable and prefer minimal, localized edits.
 * @param {string} name - Raw full name.
 * @returns {string} Name without trailing registration segment when confidently detected.
 */
function stripTrailingRegistrationIdentifier(name) {
  const original = String(name || "").trim().replace(/\s+/g, " ");
  if (!original.includes(",")) return original;

  const parts = original
    .split(",")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (parts.length < 2) return original;

  const registrationCandidate = parts[parts.length - 1];

  // Drop obvious trailing symbol-noise segments.
  // Example: "GLOBALGRID SASU, ************" -> "GLOBALGRID SASU"
  const compactRegistrationCandidate = registrationCandidate.replace(/\s+/g, "");
  const looksLikeTrailingSymbolNoise = /^(?:[*#._~=-]){6,}$/.test(compactRegistrationCandidate);
  if (looksLikeTrailingSymbolNoise) {
    const base = parts.slice(0, -1).join(", ");
    return base || original;
  }

  // Drop trailing opaque token-like blobs and BEGIN/END token banners.
  // Examples:
  // - "Shuma Watanabe, OCITOKEN::201345:97cb..."
  // - "WizardTales GmbH, -----BEGIN TOKEN-----996d...-----END TOKEN-----"
  const looksLikeTokenBanner = /BEGIN\s+[A-Z0-9_-]+/i.test(registrationCandidate)
    || /END\s+[A-Z0-9_-]+/i.test(registrationCandidate)
    || /-+\s*BEGIN\b/i.test(registrationCandidate)
    || /\bEND\s+[A-Z0-9_-]+\s*-+/i.test(registrationCandidate);
  // A bare hash/verification-token blob (e.g. an RDAP ownership-proof remark like RIPE's
  // "add this string to your object" tokens) has none of the ":"/"_"/"-" punctuation the
  // check below relies on to flag it as noise -- it's just 24-64 raw hex characters. No
  // real person/company name segment is composed purely of the letters a-f plus digits at
  // that length, so this shape alone is enough to call it opaque, independent of whether
  // the preceding text looks like a company (unlike the registration-ID path further down).
  // Example: "Samuel Cosgrove, f2939b32ff3768abf6202405ced14e89" -> "Samuel Cosgrove"
  const looksLikeBareHashToken = /^[a-f0-9]{24,64}$/i.test(registrationCandidate);
  const looksLikeOpaqueTrailingToken =
    !/\s/.test(registrationCandidate)
    && (
      (registrationCandidate.length >= 32
        && /[A-F0-9]{24,}/i.test(registrationCandidate)
        && /[:_-]/.test(registrationCandidate))
      || looksLikeBareHashToken
    );
  if (looksLikeTokenBanner || looksLikeOpaqueTrailingToken) {
    const base = parts.slice(0, -1).join(", ");
    return base || original;
  }

  const hasWhitespace = /\s/.test(registrationCandidate);
  if (hasWhitespace) return original;

  const looksLikeRegistrationId = /^(?:\d{6,}[a-z]?|[a-z]{1,4}\d{4,}[a-z0-9-]*)$/i.test(registrationCandidate);
  if (!looksLikeRegistrationId) return original;

  const base = parts.slice(0, -1).join(", ");
  if (!base) return original;

  // Only drop the registration segment when base already looks like a legal-form name.
  const baseCompacted = stripCompanyTypeSuffix(base);
  const baseHasLegalForm = String(baseCompacted || "").trim() !== base;
  return baseHasLegalForm ? base : original;
}

/**
 * Compacts an entity name for short Name field while preserving legal/full form in Long Name.
 * @ai Keep behavior stable and prefer minimal, localized edits.
 * @param {string} name - Source full name.
 * @returns {{ shortName: string, longName: string }} Compacted short name and optional long name.
 */
function compactEntityNameWithLongNameFallback(name) {
  const fullName = String(name || "").trim().replace(/\s+/g, " ");
  if (!fullName) return { shortName: "", longName: "" };

  // Strip trailing "AS<digits>" patterns (e.g., "Cogeco Connexion Inc. AS27168" -> "Cogeco Connexion Inc.")
  const withoutAsns = fullName.replace(/\s+AS\s*\d+\s*$/i, "").trim();

  const normalizedFullName = stripTrailingRegistrationIdentifier(withoutAsns);

  const fromLegalAliases = resolveCompactNameFromCommaLegalAliases(normalizedFullName);

  let effectiveFullName = normalizedFullName;
  if (fromLegalAliases) {
    // The comma-parts were recognized as aliases of the SAME underlying name (e.g.
    // "AnatoliaCore Teknoloji Limited Sirketi, ANATOLIACORE TEKNOLOJI" -- one with a
    // legal suffix, one without, or differently cased). There's no additional
    // information in the raw joined string beyond what's already in the resolved
    // value, so treat it as the full name too. Otherwise shortName and Long Name
    // would diverge below, leaking the redundant raw "Name Ltd, NAME" string into
    // Long Name instead of leaving it empty (nothing extra worth preserving).
    effectiveFullName = fromLegalAliases;
  } else if (normalizedFullName.includes(",")) {
    // The comma-parts are NOT legal aliases of each other, but the first part alone has
    // a legal corporate form (e.g. "V D C Net Company Limited, Ultra Net") -- use only
    // the first part as the canonical full name so Long Name can be populated correctly.
    const firstPart = normalizedFullName.split(",")[0].trim();
    const firstPartCompacted = stripCompanyTypeSuffix(firstPart);
    if (firstPartCompacted && firstPartCompacted !== firstPart) {
      effectiveFullName = firstPart;
    }
  }

  const withoutUnit = stripOrganizationalUnitDescriptor(fromLegalAliases || effectiveFullName) || (fromLegalAliases || effectiveFullName);
  const withoutLegalType = stripCompanyTypeSuffix(withoutUnit) || withoutUnit;
  let compactBaseShortName = withoutLegalType || effectiveFullName;
  compactBaseShortName = normalizeSimpleSingleDashAlphabeticName(compactBaseShortName);

  // A compact network short name must not end with a dangling ampersand.
  const shortName = String(compactBaseShortName || "")
    .replace(/(?:\s*&\s*)+$/g, "")
    .replace(/[\s,;:.!?-]+$/g, "")
    .trim() || compactBaseShortName;

  const normalizedEffectiveFullName = normalizeSimpleSingleDashAlphabeticName(effectiveFullName);
  const longName = shortName !== normalizedEffectiveFullName ? normalizedEffectiveFullName : "";
  return { shortName, longName };
}

/**
 * Normalizes simple single-dash alphabetic forms into spaced words.
 * Example: "Locl-net" -> "Locl Net".
 * @ai Preserve normalization/parsing rules and backward-compatible output formats.
 * @param {string} value - Source string.
 * @returns {string} Normalized string.
 */
function normalizeSimpleSingleDashAlphabeticName(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z]{3,}-[A-Za-z]{2,}$/.test(raw)) {
    return raw.replace(/-/g, " ");
  }
  return raw;
}

/**
 * Collapses exact comma-separated duplicate names.
 * Example: "Name, Name" -> "Name"
 * @ai Keep behavior stable and prefer minimal, localized edits.
 * @param {string} name - Raw name candidate.
 * @returns {string} Deduplicated name when exact duplication is detected.
 */
function collapseExactCommaDuplicateName(name) {
  const original = String(name || "").trim().replace(/\s+/g, " ");
  if (!original.includes(",")) return original;

  const parts = original
    .split(",")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (parts.length < 2) return original;

  // 2-part case: direct comparison.
  if (parts.length === 2) {
    const left = parts[0].replace(/^['""\u201c\u201d\u2018\u2019]+|['""\u201c\u201d\u2018\u2019]+$/g, "").trim();
    const right = parts[1].replace(/^['""\u201c\u201d\u2018\u2019]+|['""\u201c\u201d\u2018\u2019]+$/g, "").trim();
    if (!left || !right) return original;
    return left.toLowerCase() === right.toLowerCase() ? left : original;
  }

  // Even-count case: split into two equal halves and compare rejoined halves.
  // Handles e.g. "COMPANY CO., LTD, COMPANY CO., LTD" (4 parts).
  if (parts.length % 2 === 0) {
    const mid = parts.length / 2;
    const left = parts.slice(0, mid).join(", ");
    const right = parts.slice(mid).join(", ");
    if (left.toLowerCase() === right.toLowerCase()) return left;
  }

  return original;
}

/**
 * Detects ASN-like token variants inside free-form text.
 * Examples: "AS123456", "ASN 123456", "123456".
 * @ai Keep behavior stable and prefer minimal, localized edits.
 * @param {string} value - Input text to inspect.
 * @returns {boolean} True when an ASN-like token is present.
 */
function containsAsnLikeToken(value) {
  const text = String(value || "").trim();
  if (!text) return false;

  // Optional AS/ASN prefix + 4-10 digit ASN-like number.
  return /\b(?:AS|ASN)?\s*[-:]?\s*\d{4,10}\b/i.test(text);
}

/**
 * Detects names that look like generated maintainer/registry handles.
 * Purpose: Avoid setting network short Name to opaque handle-like values.
 * @ai Keep behavior stable and prefer minimal, localized edits.
 * @param {string} value - Candidate name.
 * @returns {boolean} True when the value looks autogenerated/handle-like.
 */
function isLikelyGeneratedHandleName(value) {
  const raw = String(value || "").trim();
  const normalized = raw.toUpperCase();
  if (!normalized) return false;

  // Typical maintainer/registry style handles (e.g. VIPY-MNT, ACME-MAINT).
  if (/^[A-Z0-9]{3,}[-_](?:MNT|MAINT|MNTNER|NIC)$/i.test(normalized)) {
    return true;
  }

  // Compact uppercase token + "-AS" pattern often indicates generated naming.
  if (/^[A-Z0-9]{5,}[-_]AS$/i.test(normalized)) {
    return true;
  }

  // ASN-prefixed handles (e.g. AS-RSSWS, AS_FOO) are often auto-generated.
  if (/^AS[-_][A-Z0-9]{3,}$/i.test(normalized)) {
    return true;
  }

  // Lowercase cc-prefix compact tokens are often machine-style handles
  // (e.g. ru-atss) rather than operator-facing display names.
  if (/^[a-z]{2}[-_][a-z0-9]{3,8}$/.test(raw)) {
    return true;
  }

  return false;
}

/**
 * Sanitizes malformed RDAP organization names that contain corruption patterns.
 * Purpose: Clean up org names that include remarks, embedded person entries, or garbage data.
 * Necessity: RDAP data sometimes includes extraneous content like contact remarks mixed into org names.
 * Patterns handled:
*   - "PERSON trading as COMPANY", "PERSON t/a COMPANY", or "PERSON dba COMPANY" → extracts "COMPANY"
 *   - "Name, remarks: GARBAGE" → extracts "Name"
 *   - Leading/trailing whitespace and punctuation cleanup
 * @ai Preserve request retries/timeouts/error classification and payload assumptions.
 * @param {string} name - Organization name possibly containing corruption.
 * @returns {string} Cleaned organization name, or original if no corruption detected.
 */
function sanitizeRdapOrgName(name) {
  const original = String(name || "").trim();
  if (!original || original.length < 2) return original;

  let candidate = original;

  // Split at ", remarks:" and take the first part (removes appended remarks/garbage)
  const remarksMatch = candidate.match(/^(.+?)\s*,\s*remarks\s*:/i);
  if (remarksMatch) {
    candidate = remarksMatch[1].trim();
  }

  // Collapse exact duplicate form "Name, Name".
  candidate = collapseExactCommaDuplicateName(candidate);

  // Collapse legal-alias duplicate form "Name Ltd, Name Pvt Ltd".
  const collapsedLegalAlias = resolveCompactNameFromCommaLegalAliases(candidate);
  if (collapsedLegalAlias) {
    candidate = collapsedLegalAlias;
  }

  // Extract text after trading-as patterns if present. Anchored, and requiring a
  // person/legal part before the marker, exactly like the twin in
  // parseRdapTradingAsIdentity below. Unanchored, the marker matched anywhere in
  // the string: "DBA Systems Inc" became "Systems Inc" and "Sundba Media Group"
  // became "Media Group", both from a mid-word or leading "dba".
  const tradingAsMatch = candidate.match(
    /^(.+?)\s+(?:trading\s+as|t\s*\/\s*a|d\s*\/?\s*b\s*\/?\s*a|dba)\s+(.+)$/i,
  );
  if (tradingAsMatch) {
    const extracted = tradingAsMatch[2].trim();
    // Use the extraction if it's substantially longer than or similar to the person part (avoid picking the person name)
    if (extracted.length >= 5) {
      candidate = extracted;
    }
  }

  // Clean trailing punctuation and comma separators
  candidate = candidate.replace(/[\s,;:.!?-]+$/g, "").trim();

  // Validate the result is still meaningful
  return candidate && candidate.length >= 2 ? candidate : original;
}

/**
* Extracts normalized organization identity from RDAP names containing
* trading-as patterns (e.g., "trading as", "t/a", "dba").
 * Purpose: Split legal/person prefix into AKA while keeping company name as canonical name.
 * Example: "Remzi Toker trading as VENTURESDC" -> { name: "VENTURESDC", knownAs: "Remzi Toker" }
 * @ai Preserve request retries/timeouts/error classification and payload assumptions.
 * @param {string} name - Raw organization name.
 * @returns {{ name: string, knownAs: string }} Parsed identity values.
 */
function parseRdapTradingAsIdentity(name) {
  const original = String(name || "").trim();
  if (!original) return { name: "", knownAs: "" };

  // Remove trailing remarks noise before parsing trading-as pattern.
  const base = original.replace(/^(.+?)\s*,\s*remarks\s*:.*/i, "$1").trim();
  const match = base.match(/^(.+?)\s+(?:trading\s+as|t\s*\/\s*a|d\s*\/?\s*b\s*\/?\s*a|dba)\s+(.+)$/i);
  if (!match) {
    return { name: sanitizeRdapOrgName(original), knownAs: "" };
  }

  const knownAs = String(match[1] || "").trim().replace(/[\s,;:.!?-]+$/g, "").trim();
  const parsedName = String(match[2] || "").trim().replace(/[\s,;:.!?-]+$/g, "").trim();

  return {
    name: sanitizeRdapOrgName(parsedName || original),
    knownAs,
  };
}

/**
 * Extracts identity from Polish civil-partnership naming style:
 * "<Company> S.C. <Partner Initial Surname ...>".
 * Purpose: Keep legal form in long/full name while moving partner tail to AKA.
 * Example:
* "NET-KONT@KT S.C. <PARTNER_1> <PARTNER_2>"
* -> { name: "NET-KONT@KT S.C.", knownAs: "<PARTNER_1> <PARTNER_2>" }
 * @ai Preserve normalization/parsing rules and backward-compatible output formats.
 * @param {string} name - Raw organization name.
 * @returns {{ name: string, knownAs: string }} Parsed identity values.
 */
function parsePolishScPartnerIdentity(name) {
  const original = String(name || "").trim();
  if (!original) return { name: "", knownAs: "" };

  const base = original.replace(/^(.+?)\s*,\s*remarks\s*:.*/i, "$1").trim();
  // The company part is required (`.+?\s+`), not optional. With `.*?` a *leading*
  // S.C. matched with nothing before it, so the Romanian "Societate Comerciala"
  // prefix in "S.C. Digital Cable Systems Romania SRL" parsed as a Polish civil
  // partnership and the name collapsed to "S.C" -- the partner-tail heuristic
  // below waves it through, because that tail does carry two Capitalized pairs.
  const match = base.match(/^(.+?\s+S\.?\s*C\.?)\s+(.+)$/i);
  if (!match) {
    return { name: sanitizeRdapOrgName(original), knownAs: "" };
  }

  const companyWithLegalForm = String(match[1] || "").trim().replace(/[\s,;:.!?-]+$/g, "").trim();
  const partnerTail = String(match[2] || "").trim().replace(/[\s,;:.!?-]+$/g, "").trim();

  // Require at least two partner-like person tokens to avoid false positives.
  // Accept either:
  // - "Initial + Surname" forms (e.g. "A. Kowalski")
  // - Full "GivenName Surname" forms (e.g. "Dariusz Koper")
  const initialSurnameTokens = partnerTail.match(/[A-Z]\.?\s+[A-Za-z\u00C0-\u024F'’-]+/g) || [];
  const fullNameTokens = partnerTail.match(/[A-Z][A-Za-z\u00C0-\u024F'’-]+\s+[A-Z][A-Za-z\u00C0-\u024F'’-]+/g) || [];
  const looksLikePartnerTail = initialSurnameTokens.length >= 2 || fullNameTokens.length >= 2;
  if (!looksLikePartnerTail) {
    return { name: sanitizeRdapOrgName(original), knownAs: "" };
  }

  return {
    name: sanitizeRdapOrgName(companyWithLegalForm || original),
    knownAs: partnerTail,
  };
}

/**
 * Countries where LACNIC (and similarly-structured RIRs) are known to represent an
 * individually-held resource's org name as "<Person Name> (<Trade Name>)", with no
 * separate incorporated-entity record to hold the trade name. Confirmed for Guatemala
 * via RDAP (autnum vs. entity contact record) plus independent bgp.tools corroboration
 * for AS272876 ("EDWIN RAYMUNDO HERNÁNDEZ PEC (IMPORTADORA Y EXPORTADORA INTERCEL)").
 * Extend only after confirming a new country follows the same convention - this list is
 * the primary guard against misreading unrelated parenthetical usage (e.g. "Acme Corp
 * (Brazil)", "Acme (formerly Foo)") as a person/trade-name split.
 * @ai Preserve normalization/parsing rules and backward-compatible output formats.
 */
const PARENTHESIZED_TRADE_NAME_COUNTRIES = new Set(["GT"]);

/**
 * Corporate/descriptive words that disqualify a parenthesis-preceding phrase from being
 * treated as a personal name, even if it otherwise has the right word count and casing.
 * @ai Preserve normalization/parsing rules and backward-compatible output formats.
 */
const PARENTHESIZED_TRADE_NAME_DISQUALIFYING_WORDS = new Set([
  "network", "networks", "telecom", "telecomunicaciones", "internet",
  "systems", "solutions", "group", "grupo", "corp", "corporation",
  "company", "compania", "compañía", "servicios", "services",
]);

/**
 * Checks whether text has the shape of a Latin American full personal name: a small
 * number of capitalized words, no digits, and no corporate/descriptive vocabulary.
 * Purpose: Second guard (alongside the country allow-list) for
 * parseParenthesizedTradeNameIdentity(), so the split only fires when the text before
 * the parenthesis plausibly names a person rather than a company.
 * @ai Preserve normalization/parsing rules and backward-compatible output formats.
 * @param {string} text - Candidate text preceding a parenthesis.
 * @returns {boolean} True when the text looks like a personal name.
 */
function looksLikePersonalNameShape(text) {
  const trimmed = String(text || "").trim().replace(/\s+/g, " ");
  if (!trimmed || /\d/.test(trimmed)) return false;

  const words = trimmed.split(" ").filter(Boolean);
  if (words.length < 3 || words.length > 5) return false;

  if (words.some((word) => PARENTHESIZED_TRADE_NAME_DISQUALIFYING_WORDS.has(word.toLowerCase()))) {
    return false;
  }

  const wordShapeRegex = /^[A-ZÀ-ÖØ-Þ][a-zà-öø-þ]*$|^[A-ZÀ-ÖØ-Þ]+$/;
  return words.every((word) => wordShapeRegex.test(word));
}

/**
 * Extracts identity from "<Person Name> (<Trade Name>)" org names used by some RIRs
 * for individually-held (non-incorporated) resources.
 * Purpose: Move the trade name to canonical Name while keeping the person's legal name
 * as AKA, gated on country + personal-name shape to avoid misreading unrelated
 * parenthetical usage as a person/trade-name split.
 * Example: "EDWIN RAYMUNDO HERNÁNDEZ PEC (IMPORTADORA Y EXPORTADORA INTERCEL)" (GT)
 * -> { name: "IMPORTADORA Y EXPORTADORA INTERCEL", knownAs: "EDWIN RAYMUNDO HERNÁNDEZ PEC" }
 * @ai Preserve normalization/parsing rules and backward-compatible output formats.
 * @param {string} name - Raw organization name.
 * @param {string} [countryCode=""] - ISO country code for the record being named.
 * @returns {{ name: string, knownAs: string }} Parsed identity values.
 */
function parseParenthesizedTradeNameIdentity(name, countryCode = "") {
  const original = String(name || "").trim();
  if (!original) return { name: "", knownAs: "" };

  const normalizedCountry = String(countryCode || "").trim().toUpperCase();
  if (!PARENTHESIZED_TRADE_NAME_COUNTRIES.has(normalizedCountry)) {
    return { name: sanitizeRdapOrgName(original), knownAs: "" };
  }

  const match = original.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
  if (!match) return { name: sanitizeRdapOrgName(original), knownAs: "" };

  const personCandidate = String(match[1] || "").trim();
  const tradeNameCandidate = String(match[2] || "").trim();
  if (!tradeNameCandidate || !looksLikePersonalNameShape(personCandidate)) {
    return { name: sanitizeRdapOrgName(original), knownAs: "" };
  }

  return {
    name: sanitizeRdapOrgName(tradeNameCandidate),
    knownAs: personCandidate,
  };
}

/**
 * Resolves canonical name + AKA identity from known malformed/alias patterns.
 * Purpose: Keep all AKA extraction rules in one place.
 * @ai Preserve normalization/parsing rules and backward-compatible output formats.
 * @param {string} name - Raw organization name.
 * @param {string} [countryCode=""] - ISO country code, used by country-gated rules
 *   (currently only parseParenthesizedTradeNameIdentity).
 * @returns {{ name: string, knownAs: string, fullName: string }} Parsed identity values.
 *   fullName is the original untouched input, populated only when a split occurred
 *   (knownAs non-empty), so callers can preserve it as Long Name.
 */
function parseOrganizationNameIdentity(name, countryCode = "") {
  const tradingAsIdentity = parseRdapTradingAsIdentity(name);
  if (String(tradingAsIdentity?.knownAs || "").trim()) {
    return { ...tradingAsIdentity, fullName: String(name || "").trim() };
  }

  const scIdentity = parsePolishScPartnerIdentity(name);
  if (String(scIdentity?.knownAs || "").trim()) {
    return { ...scIdentity, fullName: String(name || "").trim() };
  }

  const parenIdentity = parseParenthesizedTradeNameIdentity(name, countryCode);
  if (String(parenIdentity?.knownAs || "").trim()) {
    return { ...parenIdentity, fullName: String(name || "").trim() };
  }

  return { ...tradingAsIdentity, fullName: "" };
}

/**
 * Generates a deterministic non-AS fallback network name with optional suffix.
 * Purpose: Keep required name fields populated when higher-quality sources fail.
 * Necessity: Explicitly avoids AS<id>/AS<asn> placeholder formats.
 * @ai Preserve request retries/timeouts/error classification and payload assumptions.
 * @param {string|number} _asn - Unused (kept for signature compatibility).
 * @param {string|number} networkId - CP network record ID used as fallback.
 * @param {string} [suffix=""] - Optional suffix to append (e.g., " #42" for deleted records).
 * @returns {string} Generated fallback name string (e.g., "Network 42 #42").
 */
function getDeterministicNetworkFallbackName(asn, networkId, suffix = "") {
  void asn;
  return `Network ${networkId}${suffix}`;
}

/**
 * Selects the first meaningful non-handle network name from candidate strings.
 * Purpose: Prefer human-readable naming before falling back to deterministic placeholders.
 * @ai Preserve request retries/timeouts/error classification and payload assumptions.
 * @param {string[]} candidates - Raw candidate name strings ordered by preference.
 * @returns {string} Best compacted non-handle name, or empty string when none found.
 */
function pickPreferredNetworkNameCandidate(candidates) {
  for (const candidate of candidates || []) {
    const compacted = compactEntityNameWithLongNameFallback(String(candidate || "").trim());
    const base = String(compacted?.shortName || candidate || "").trim();
    if (!base) continue;
    if (isLikelyGeneratedHandleName(base)) continue;
    if (/^AS\s*\d+$/i.test(base)) continue;
    return base;
  }
  return "";
}
