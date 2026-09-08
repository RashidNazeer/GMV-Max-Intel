// The date arithmetic, tested — because it was wrong in production and nothing
// caught it.
//
// "Last 7 days" rendered 8 shop days and "Last 30 days" rendered 31, so every
// figure on every screen covered one more day than its label claimed and the
// model trained on an extra day. It was a single character in one expression,
// and no test existed that would have noticed.
import {
  reportWindow, modelWindow, chunkWindow, addDays, daysBetween, SETTLING_DAYS,
} from '../src/lib/window.js';

let pass = 0; let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// A fixed clock, so a test that passes today passes in March.
const NOW = new Date('2026-09-08T09:15:00Z');

console.log('\n── N inclusive days means N, not N+1 ──');
for (const days of [1, 7, 14, 30, 60, 90]) {
  const w = reportWindow(days, { now: NOW });
  check(`Last ${days} days spans exactly ${days} days`, w.spanDays, days);
}

console.log('\n── the window ends where the data has settled ──');
{
  const w = reportWindow(7, { now: NOW });
  check('ends SETTLING_DAYS back', w.end, addDays('2026-09-08', -SETTLING_DAYS));
  check('the exact dates the app will show', [w.start, w.end], ['2026-08-31', '2026-09-06']);
  // The reviewer measured 2026-08-30 → 2026-09-06 in the running app. That is
  // the bug, and it must not come back.
  check('NOT the old 8-day window', w.start === '2026-08-30', false);
}
{
  const w = reportWindow(30, { now: NOW });
  check('30 days is 31 dates apart minus one', [w.start, w.end], ['2026-08-08', '2026-09-06']);
  check('30 days spans 30', daysBetween(w.start, w.end), 30);
}

console.log('\n── the prior period is adjacent, equal and non-overlapping ──');
{
  const w = reportWindow(7, { now: NOW });
  check('prior period is the same length', w.priorSpanDays, w.spanDays);
  check('prior period ends the day before the window starts', w.priorEnd, addDays(w.start, -1));
  check('no overlap', daysBetween(w.priorStart, w.priorEnd) + daysBetween(w.start, w.end),
    daysBetween(w.priorStart, w.end));
  check('the exact prior dates', [w.priorStart, w.priorEnd], ['2026-08-24', '2026-08-30']);
}

console.log('\n── month, year and leap boundaries ──');
check('crosses a month end', reportWindow(7, { now: new Date('2026-03-04T00:00:00Z') }).start, '2026-02-24');
check('crosses a year end', reportWindow(7, { now: new Date('2026-01-04T00:00:00Z') }).start, '2025-12-27');
check('February in a leap year', addDays('2028-02-28', 1), '2028-02-29');
check('February in a common year', addDays('2027-02-28', 1), '2027-03-01');
// Date arithmetic runs through UTC, so a daylight-saving transition cannot move
// a boundary — the shop timezone is applied in SQL, once.
check('spring-forward night is still one day', daysBetween('2026-03-08', '2026-03-09'), 2);
check('autumn-back night is still one day', daysBetween('2026-11-01', '2026-11-02'), 2);

console.log('\n── the model window is NOT the report window ──');
{
  const w = reportWindow(7, { now: NOW });
  const m = modelWindow(w.end, { trainingDays: 120 });
  check('training ends at the reporting cutoff — no future leakage', m.end, w.end);
  check('training reaches far further back than the report', m.spanDays, 120);
  check('selecting 7 days does not shrink training history', m.spanDays > w.spanDays, true);
}

console.log('\n── chunking to the provider cap ──');
{
  // The sync asked for 92 days against a documented 90-day maximum and failed
  // for every shop on every run.
  const c = chunkWindow('2026-06-07', '2026-09-06', 90);
  check('92 days becomes two requests', c.length, 2);
  check('no chunk exceeds the cap', c.every((x) => x.days <= 90), true);
  check('chunks are contiguous', addDays(c[0].end, 1), c[1].start);
  check('chunks cover the whole window exactly',
    c.reduce((a, x) => a + x.days, 0), daysBetween('2026-06-07', '2026-09-06'));
  check('a window inside the cap stays one request', chunkWindow('2026-08-01', '2026-08-30', 90).length, 1);
  check('exactly 90 days stays one request', chunkWindow('2026-06-09', '2026-09-06', 90).length, 1);
}

console.log('\n── malformed input fails loudly rather than silently ──');
{
  let threw = false;
  try { addDays('not-a-date', 1); } catch { threw = true; }
  check('a non-date throws instead of producing NaN', threw, true);
  let threw2 = false;
  try { addDays('2026-13-45', 1); } catch { threw2 = true; }
  check('an impossible date throws', threw2, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
