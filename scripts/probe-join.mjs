// Does affiliate content_id join to /videos/performance video_id?
// The creative layer depends on it: our commission evidence is per order line
// (so we know paid vs organic per video), but views, engagement and posted_date
// only exist on the video feed. If the ids do not match, the two halves of the
// creative picture cannot be put on the same row.
import { createClient } from '@supabase/supabase-js';
import { createReacherClient } from '../src/lib/reacher/client.js';
import { need } from './_env.mjs';

const [URL, SERVICE, KEY] = need('VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REACHER_API');
const db = createClient(URL, SERVICE, { auth: { persistSession: false } });
const r = createReacherClient({ apiKey: KEY });

const { data: shop } = await db.from('shops').select('id, shop_name, reacher_shop_id')
  .eq('reacher_shop_id', 11515).single();

const { data: lines } = await db.from('affiliate_order_lines')
  .select('content_id, content_type, payment_amount')
  .eq('shop_id', shop.id).eq('content_type', 'Video').limit(1000);

const ours = new Set(lines.map((l) => l.content_id).filter(Boolean));
console.log(`our Video-type lines: ${lines.length}, distinct content_id: ${ours.size}`);
console.log(`  sample: ${[...ours].slice(0, 3).join(', ')}`);

const end = new Date().toISOString().slice(0, 10);
const start = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
const res = await r.post('/videos/performance', {
  shopId: 11515,
  body: { start_date: start, end_date: end, page: 1, page_size: 100, sort_by: 'video_gmv', sort_dir: 'desc' },
});
const feed = res.data || [];
console.log(`feed rows: ${feed.length} of ${res.pagination?.total_count} total`);
console.log(`  sample: ${feed.slice(0, 3).map((v) => v.video_id).join(', ')}`);

const hits = feed.filter((v) => ours.has(String(v.video_id)));
console.log(`\nJOIN: ${hits.length}/${feed.length} of the feed's top videos appear in our order lines`);
if (hits[0]) console.log(`  e.g. ${hits[0].video_id} @${hits[0].creator_handle} — feed GMV ${hits[0].video_gmv}`);

// How concentrated is the creative? Answered from our own classified lines.
const byVideo = new Map();
for (const l of lines) {
  if (!l.content_id) continue;
  byVideo.set(l.content_id, (byVideo.get(l.content_id) || 0) + Number(l.payment_amount || 0));
}
const sorted = [...byVideo.values()].sort((a, b) => b - a);
const total = sorted.reduce((a, b) => a + b, 0);
const share = (n) => ((sorted.slice(0, n).reduce((a, b) => a + b, 0) / total) * 100).toFixed(1) + '%';
console.log(`\nconcentration over ${sorted.length} videos (first 1000 lines only):`);
console.log(`  top 1: ${share(1)}   top 5: ${share(5)}   top 10: ${share(10)}   top 25: ${share(25)}`);
