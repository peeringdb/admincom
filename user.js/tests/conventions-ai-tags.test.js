'use strict';

// Conformance tests for the @ai annotation convention. An @ai tag states ONE
// invariant specific to its function that a plausible diff could silently
// violate. Litmus (docs/CONVENTIONS.md): "If the sentence could be pasted onto
// a different function unchanged and still read true, it is not an @ai tag."
//
// Enforcement rests on the observation that boilerplate is, by definition,
// repeated -- so no similarity scoring is needed:
//   (a) the seven historical stock phrases are denylisted outright (they were
//       stripped repo-wide in favor of one global posture sentence in
//       AGENTS.md; this blocks reintroduction with a precise error);
//   (b) identical normalized @ai text may appear at most twice repo-wide
//       (permits one deliberate twin pair, makes template reuse impossible);
//   (c) tag prose must carry at least 30 characters of substance.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE_FILES = [
  'peeringdb-cp-consolidated-tools.src.js',
  'peeringdb-fp-consolidated-tools.src.js',
  'peeringdb-deskpro-tools.src.js',
  'lib/admincom-common.js',
  'lib/cp-name-normalization.js',
  'lib/admincom-entity-exclusions.js',
];

// The seven historical stock phrases (exact text). These said nothing about
// any particular function -- they restated the repo-wide editing posture now
// stated once in AGENTS.md.
const STOCK_PHRASES = [
  'Keep behavior stable and prefer minimal, localized edits.',
  'Preserve request retries/timeouts/error classification and payload assumptions.',
  'Preserve selector contracts and idempotent DOM mutation behavior.',
  'Preserve normalization/parsing rules and backward-compatible output formats.',
  'Preserve shared storage/cache key contracts and TTL behavior.',
  'Preserve execution ordering, locks, and route/module boundaries.',
  'Preserve menu command registration behavior and gating on feature flag.',
];

const MAX_IDENTICAL_OCCURRENCES = 2;
const MIN_PROSE_LENGTH = 30;

// An @ai tag line in either comment form. The prose runs to end of line;
// multi-line continuation is not part of the convention.
const AI_TAG_REGEX = /^\s*(?:\*|\/\/)\s*@ai\s+(.*)$/;

function normalize(prose) {
  return prose.trim().replace(/\s+/g, ' ');
}

/** Collects every @ai tag with file, 1-based line, and normalized prose. */
function collectTags() {
  const tags = [];
  for (const relPath of SOURCE_FILES) {
    const lines = fs.readFileSync(path.join(ROOT, relPath), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const m = AI_TAG_REGEX.exec(lines[i]);
      if (!m) continue;
      tags.push({ file: relPath, line: i + 1, prose: normalize(m[1]) });
    }
  }
  return tags;
}

test('@ai tag specificity', async (t) => {
  const tags = collectTags();

  await t.test('no @ai tag reuses a denylisted stock phrase', () => {
    const stock = new Set(STOCK_PHRASES);
    const bad = tags
      .filter((tag) => stock.has(tag.prose))
      .map((tag) => `${tag.file}:${tag.line} stock phrase: "${tag.prose}"`);
    assert.deepEqual(bad, [],
      `stock @ai phrases are banned -- the posture lives in AGENTS.md; ` +
      `state this function's own invariant or drop the tag:\n${bad.join('\n')}`);
  });

  await t.test(`identical @ai text appears at most ${MAX_IDENTICAL_OCCURRENCES} times repo-wide`, () => {
    const groups = new Map();
    for (const tag of tags) {
      if (!groups.has(tag.prose)) groups.set(tag.prose, []);
      groups.get(tag.prose).push(`${tag.file}:${tag.line}`);
    }
    const bad = [];
    for (const [prose, sites] of groups) {
      if (sites.length > MAX_IDENTICAL_OCCURRENCES) {
        bad.push(`"${prose}" appears ${sites.length}x:\n  ${sites.join('\n  ')}`);
      }
    }
    assert.deepEqual(bad, [],
      `boilerplate is, by definition, repeated -- an invariant shared by ` +
      `${MAX_IDENTICAL_OCCURRENCES + 1}+ functions is not function-specific:\n${bad.join('\n')}`);
  });

  await t.test(`@ai prose carries at least ${MIN_PROSE_LENGTH} characters of substance`, () => {
    const bad = tags
      .filter((tag) => tag.prose.length < MIN_PROSE_LENGTH)
      .map((tag) => `${tag.file}:${tag.line} too short (${tag.prose.length} chars): "${tag.prose}"`);
    assert.deepEqual(bad, [],
      `an @ai tag must state a real invariant, not a stub:\n${bad.join('\n')}`);
  });
});
