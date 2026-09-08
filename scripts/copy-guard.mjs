// The owner exception, enforced.
//
// The owner accepted a long review of this product EXCEPT the finding that its
// attribution language claims more certainty than the evidence supports. That
// critique proposed replacing "Proven return" and the floor/ceiling framing
// with "partial commission-attributed ROAS" and similar hedges. It was
// considered and rejected.
//
// A rejected critique is easy to re-implement by accident six weeks later,
// especially during a redesign that legitimately moves this copy around. So the
// protected phrases are asserted here, and the banned replacements are asserted
// absent. Layout may change freely; claim strength may not.
//
// If this fails, the question is not "how do I make it pass". It is "did the
// owner change their mind?" — and if they did, edit PROTECTED here in the same
// commit, so the record of the decision moves with the decision.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPY } from '../src/lib/copy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

// Phrases whose MEANING and CERTAINTY the owner chose to keep.
const PROTECTED = [
  'would have happened without your ads',
  'Proven return',
  'The real return is between',
  'that is the floor, and every dollar in it is certainly ad-driven',
  'which programme paid says what drove the sale',
  'a guess dressed as a measurement',
];

// Replacements from the rejected critique. Their presence would mean the
// excluded finding was implemented after all.
const BANNED = [
  'partial commission-attributed',
  'commission-attributed ROAS',
  'apparent return',
  'estimated proven return',
];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);

// A guard that reads no files passes vacuously. This project has been bitten by
// that three times, so the input is asserted before the assertions are made.
if (files.length < 10) {
  console.error(`copy-guard: only found ${files.length} source files — the path is wrong, so this check proves nothing`);
  process.exit(1);
}

// Check the RESOLVED strings, not the source text. The registry wraps long
// copy across concatenated string literals, so a phrase can be intact for the
// reader while spanning a quote boundary in the file — scanning source would
// then fail on formatting rather than on meaning, which is the wrong thing to
// be strict about. The rendered value is what the owner's decision is about.
const resolved = [
  COPY.organicClaim,
  COPY.decompositionExplainer,
  COPY.bandExplainer,
  ...Object.values(COPY.seg || {}),
].join('\n');

const source = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const corpus = `${resolved}\n${source}`;

if (source.length < 20000) {
  console.error(`copy-guard: source is only ${source.length} chars — refusing to pass on an empty read`);
  process.exit(1);
}
if (resolved.length < 800) {
  console.error(`copy-guard: the copy registry resolved to only ${resolved.length} chars — it has been gutted`);
  process.exit(1);
}

let failed = 0;

for (const phrase of PROTECTED) {
  if (!corpus.includes(phrase)) {
    console.error(`  MISSING protected copy: "${phrase}"`);
    failed++;
  }
}

for (const phrase of BANNED) {
  // Allow it in this file and in the comments that explain the exception.
  const hits = files.filter((f) => {
    if (f.endsWith('copy-guard.mjs')) return false;
    const text = fs.readFileSync(f, 'utf8');
    if (!text.includes(phrase)) return false;
    // A line that merely documents the rejected wording is fine; one that
    // renders it is not. Comment lines start with // or * after trimming.
    return text.split('\n').some((line) =>
      line.includes(phrase) && !/^\s*(\/\/|\*|\/\*)/.test(line));
  });
  if (hits.length) {
    console.error(`  BANNED copy from the excluded critique: "${phrase}" in ${hits.map((h) => path.relative(ROOT, h)).join(', ')}`);
    failed++;
  }
}

// Positive control: a phrase that must NOT be found, proving the search works.
if (corpus.includes('__copy_guard_control_phrase__')) {
  console.error('copy-guard: positive control matched — the corpus is not what it claims to be');
  process.exit(1);
}

if (failed) {
  console.error(`\ncopy-guard: ${failed} violation(s). See the header of this file before "fixing" them.`);
  process.exit(1);
}

console.log(`copy-guard: ${PROTECTED.length} protected phrases intact, ${BANNED.length} rejected rewrites absent (${files.length} files)`);
