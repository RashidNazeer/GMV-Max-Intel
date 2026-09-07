// Exploratory fit for layer 5, before any of it becomes product code.
//
//   node scripts/probe-elasticity.mjs [reacherShopId]
//
// The model is deliberately the simplest thing that can express diminishing
// returns:
//
//     revenue = a * spend^b        =>      log(revenue) = log(a) + b*log(spend)
//
// b is the ELASTICITY. b = 1 means every extra dollar returns what the last one
// did. b < 1 means each extra dollar returns less, which is what ad delivery
// almost always does. The useful consequence is exact:
//
//     marginal ROAS = b x average ROAS
//
// so "what does the next dollar return" falls straight out of one coefficient.
//
// ── THE TRAP THIS SCRIPT EXISTS TO CHECK ───────────────────────────────────
// Biostime's spend FELL across the window while its ROI ROSE. That is the
// signature of diminishing returns — and equally the signature of anything else
// that improved over the same weeks. Spend and time are correlated here, so a
// naive fit cannot tell the two apart and would confidently report an
// elasticity that is really a calendar.
//
// So it fits twice: once naively, once with a linear time control. If the
// coefficient collapses when time is added, the naive number was a mirage.
import { createClient } from '@supabase/supabase-js';
import { need } from './_env.mjs';

const [URL, SERVICE] = need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
const db = createClient(URL, SERVICE, { auth: { persistSession: false } });
const reacherShopId = Number(process.argv[2] || 11528);

// ── ordinary least squares, k regressors, via normal equations ──────────────
function ols(X, y) {
  const n = X.length, k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  // Gauss-Jordan on [XtX | I] to get both the coefficients and (XtX)^-1,
  // which is what the standard errors need.
  const M = XtX.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;          // singular
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * k; j++) M[c][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let j = 0; j < 2 * k; j++) M[r][j] -= f * M[c][j];
    }
  }
  const inv = M.map((row) => row.slice(k));
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));

  const yhat = X.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
  const ybar = y.reduce((a, b) => a + b, 0) / n;
  const ssr = y.reduce((s, v, i) => s + (v - yhat[i]) ** 2, 0);
  const sst = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
  const df = n - k;
  const sigma2 = ssr / df;
  const se = inv.map((row, i) => Math.sqrt(sigma2 * row[i]));
  return { beta, se, r2: 1 - ssr / sst, n, df };
}

const { data: shop } = await db.from('shops')
  .select('id, shop_name').eq('reacher_shop_id', reacherShopId).single();

const { data: rows } = await db.from('gmv_max_daily_metrics')
  .select('day, spend, revenue').eq('shop_id', shop.id).order('day');

const byDay = new Map();
for (const r of rows) {
  const e = byDay.get(r.day) || { spend: 0, rev: 0 };
  e.spend += Number(r.spend) || 0;
  e.rev += Number(r.revenue) || 0;
  byDay.set(r.day, e);
}

// Our own verified ad-driven revenue for the same days.
const days = [...byDay.entries()].filter(([, v]) => v.spend > 0 && v.rev > 0).sort();
const { data: mine } = await db.rpc('shop_spend_daily', {
  p_shop_id: shop.id, p_start: days[0][0], p_end: days[days.length - 1][0],
});
const verified = new Map((mine || []).map((r) => [String(r.day), Number(r.measured_paid_gmv) || 0]));

console.log(`${shop.shop_name} — ${days.length} days with spend\n`);

function fit(label, getY) {
  const pts = days
    .map(([d, v], i) => ({ d, i, spend: v.spend, y: getY(d, v) }))
    .filter((p) => p.y > 0);
  if (pts.length < 15) {
    console.log(`${label}: only ${pts.length} usable days — refusing to fit`);
    return;
  }
  const ls = pts.map((p) => Math.log(p.spend));
  const ly = pts.map((p) => Math.log(p.y));

  const naive = ols(ls.map((v) => [1, v]), ly);
  const timed = ols(ls.map((v, i) => [1, v, pts[i].i]), ly);

  const totalSpend = pts.reduce((a, p) => a + p.spend, 0);
  const totalRev = pts.reduce((a, p) => a + p.y, 0);
  const avgRoas = totalRev / totalSpend;

  const show = (name, m) => {
    if (!m) { console.log(`  ${name}: could not fit`); return; }
    const b = m.beta[1], se = m.se[1];
    const lo = b - 1.96 * se, hi = b + 1.96 * se;
    console.log(
      `  ${name.padEnd(22)} elasticity ${b.toFixed(3)} ±${(1.96 * se).toFixed(3)}  ` +
      `[${lo.toFixed(2)}, ${hi.toFixed(2)}]   R² ${m.r2.toFixed(3)}   t ${(b / se).toFixed(2)}`,
    );
    console.log(
      `  ${''.padEnd(22)} avg ROAS ${avgRoas.toFixed(2)} -> marginal ${(b * avgRoas).toFixed(2)}  ` +
      `[${(lo * avgRoas).toFixed(2)}, ${(hi * avgRoas).toFixed(2)}]`,
    );
  };

  console.log(`\n${label}   (${pts.length} days, ${totalSpend.toFixed(0)} spend, ${totalRev.toFixed(0)} revenue)`);
  show('naive', naive);
  show('with time control', timed);

  if (naive && timed) {
    const drop = naive.beta[1] - timed.beta[1];
    if (Math.abs(drop) > 0.25) {
      console.log(`  >> the coefficient moves ${drop.toFixed(2)} when time is controlled for —`);
      console.log(`     the naive fit was substantially measuring the calendar, not spend.`);
    } else {
      console.log(`  >> stable under a time control (moves ${drop.toFixed(2)}) — the relationship is with spend.`);
    }
    if (timed.se[1] > 0.35) {
      console.log(`  >> but the interval is too wide to act on: a single number here would be false precision.`);
    }
  }
}

fit('GMV Max reported revenue', (d, v) => v.rev);
fit('Verified ad-driven revenue', (d) => verified.get(d) ?? 0);

// Correlation between spend and time is the thing that makes this hard.
const n = days.length;
const t = days.map((_, i) => i);
const s = days.map(([, v]) => v.spend);
const mt = t.reduce((a, b) => a + b, 0) / n, ms = s.reduce((a, b) => a + b, 0) / n;
const cov = t.reduce((a, v, i) => a + (v - mt) * (s[i] - ms), 0);
const st = Math.sqrt(t.reduce((a, v) => a + (v - mt) ** 2, 0));
const ss = Math.sqrt(s.reduce((a, v) => a + (v - ms) ** 2, 0));
console.log(`\ncorrelation between spend and day-index: ${(cov / (st * ss)).toFixed(3)}`);
console.log('(near zero is ideal — strongly negative means spend and time are entangled)');
