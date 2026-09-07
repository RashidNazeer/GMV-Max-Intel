// Discovery probe for spec layers 2-4: channel mix, creative, price/promo.
//
// The rule this project works to: field names come from live payloads, never
// from a written spec. The vendor document listed most endpoints as guesses and
// several were wrong. So before an adapter is written, the response is printed.
//
//   node scripts/probe-layers.mjs [shopId]
import fs from 'node:fs';
import path from 'node:path';
import { createReacherClient } from '../src/lib/reacher/client.js';
import { need, ROOT_DIR } from './_env.mjs';

const [KEY] = need('REACHER_API');
const shopId = Number(process.argv[2] || 11515);
const END = new Date().toISOString().slice(0, 10);
const START = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

const r = createReacherClient({ apiKey: KEY });
const OUT = path.join(ROOT_DIR, '.probe');
fs.mkdirSync(OUT, { recursive: true });

// Print the shape, not the whole payload: revenue data should not scroll
// through a terminal or land in a transcript.
function describe(label, value, depth = 0) {
  const pad = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    console.log(`${pad}${label}: array[${value.length}]`);
    if (value.length) describe('[0]', value[0], depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    console.log(`${pad}${label}: {`);
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object') describe(k, v, depth + 1);
      else console.log(`${pad}  ${k}: ${typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : JSON.stringify(v)}`);
    }
    console.log(`${pad}}`);
    return;
  }
  console.log(`${pad}${label}: ${JSON.stringify(value)}`);
}

async function probe(name, fn) {
  process.stdout.write(`\n===== ${name} =====\n`);
  try {
    const res = await fn();
    fs.writeFileSync(path.join(OUT, `${name.replace(/\W+/g, '-')}.json`), JSON.stringify(res, null, 2));
    describe('response', res);
    return res;
  } catch (e) {
    console.log(`  FAILED  ${e.message}${e.requestId ? `  (request_id ${e.requestId})` : ''}`);
    return null;
  }
}

console.log(`shop ${shopId} · ${START} → ${END}`);

await probe('shop-gmv-timeseries', () =>
  r.post('/shop-gmv/timeseries', { shopId, body: { start_date: START, end_date: END } }));

await probe('seller-center-shop-overview', () =>
  r.post('/seller-center/shop-overview', { shopId, body: { start_date: START, end_date: END } }));

await probe('seller-center-products', () =>
  r.post('/seller-center/products', { shopId, body: { start_date: START, end_date: END, page: 1, page_size: 3 } }));

await probe('videos-performance', () =>
  r.post('/videos/performance', { shopId, body: { start_date: START, end_date: END, page: 1, page_size: 3, sort_by: 'video_gmv', sort_dir: 'desc' } }));

await probe('pnl-products', () => r.get('/pnl/products', { shopId }));

await probe('pnl-summary', () =>
  r.post('/pnl/summary', { shopId, body: { start_date: START, end_date: END } }));

console.log(`\nfull payloads written to ${OUT} (git-ignored — they contain client revenue)`);
