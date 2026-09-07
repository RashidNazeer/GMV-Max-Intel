// Creative health — "are you one video away from a bad month?"
//
// Every figure here is computed from our own classified order lines, so each
// video's revenue arrives already split into paid and organic. Reacher's video
// feed supplies views, title and posting date, which the order lines do not
// carry; it never supplies money.
import { useQuery } from '@tanstack/react-query';
import { shopCreativeHealth, shopTopVideos } from '../lib/api.js';
import { Card, Stat, Note, Skeleton, Empty, Basis, MiniBar, Trend, money, moneyExact, pct } from '../components/ui.jsx';

export default function CreativePage({ shop, start, end, days }) {
  const cur = shop.currency || 'USD';
  const healthQ = useQuery({
    queryKey: ['creative', shop.id, start, end],
    queryFn: () => shopCreativeHealth(shop.id, start, end),
  });
  const videosQ = useQuery({
    queryKey: ['vids50', shop.id, start, end],
    queryFn: () => shopTopVideos(shop.id, start, end, 50),
  });

  const h = healthQ.data;
  if (healthQ.error) return <Note tone="warn">{healthQ.error.message}</Note>;
  if (!healthQ.isLoading && (!h || !Number(h.video_count))) {
    return <Empty title="No video revenue in this window">
      Creative health is computed from affiliate order lines that carry a video id. This shop has none for {start} → {end}.
    </Empty>;
  }

  const gmv = Number(h?.gmv) || 0;
  const top1Value = gmv * (Number(h?.top1_share) || 0);
  const fatShare = gmv ? Number(h?.fatigued_gmv) / gmv : null;

  return (
    <div className="grid" style={{ gap: 16 }}>
      {healthQ.isLoading ? <Card><Skeleton h={110} /></Card> : (
        <div className="card pad">
          <div className="k">Creative concentration <Basis kind="measured" /></div>
          <div className="headline">
            Your top 5 videos are <em style={{ color: Number(h.top5_share) >= 0.5 ? 'var(--danger)' : 'var(--accent)' }}>
              {pct(h.top5_share)}
            </em> of affiliate revenue.
          </div>
          <p className="muted" style={{ fontSize: 13, marginTop: -6 }}>
            The single best video is {pct(h.top1_share)} — {money(top1Value, cur)} over this window. Video
            performance decays; concentration is how much revenue has nothing behind it when it does.
          </p>
        </div>
      )}

      <div className="grid g4">
        <Stat k="Videos earning" basis="measured" v={Number(h?.video_count || 0).toLocaleString()}
          sub={`${Number(h?.creators || 0).toLocaleString()} creators · ${money(gmv, cur)}`} />
        <Stat k="Top 10 share" basis="measured"
          tone={Number(h?.top10_share) >= 0.6 ? 'warning' : undefined}
          v={pct(h?.top10_share)} sub={`top 1 is ${pct(h?.top1_share)}`} />
        <Stat k="Fading" basis="measured"
          tone={fatShare >= 0.3 ? 'danger' : undefined}
          v={h?.trend_measurable === false ? '—' : money(h?.fatigued_gmv, cur)}
          sub={h?.trend_measurable === false
            ? 'needs a 14-day window to compare against'
            : `${h?.fatigued_videos} videos down >30% week-on-week`} />
        <Stat k="Rising" basis="measured" tone="organic"
          v={h?.trend_measurable === false ? '—' : money(h?.rising_gmv, cur)}
          sub={h?.trend_measurable === false
            ? 'needs a 14-day window to compare against'
            : `${h?.rising_videos} videos up >30% · ${h?.new_videos} first sold this week`} />
      </div>

      {h?.freshness_coverage != null && Number(h.freshness_coverage) < 0.9 && (
        <Note tone="info">
          Posting dates are known for <strong>{pct(h.freshness_coverage)}</strong> of video revenue — the video
          feed returns the top of a GMV-sorted list, not every video. Freshness below describes that portion.
        </Note>
      )}

      {h?.fresh_gmv != null && (
        <Card title="Freshness" sub="Revenue from videos posted in the last 30 days">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1 }}>
              <MiniBar value={gmv ? Number(h.fresh_gmv) / gmv : 0} color="var(--organic)" />
            </div>
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{money(h.fresh_gmv, cur)}</strong>
            <span className="muted">{pct(gmv ? Number(h.fresh_gmv) / gmv : null)} of video revenue</span>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            A low figure means the shop is living off old creative. That is not automatically bad — a
            durable winner is valuable — but it is fragile if nothing new is being produced behind it.
          </p>
        </Card>
      )}

      <Card title="Videos by revenue" sub="Split by what drove each sale, with last 7 days against the 7 before" pad={false}>
        {videosQ.isLoading ? <div className="pad"><Skeleton h={220} /></div> : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Video</th><th>Creator</th><th className="num">Age</th>
                  <th className="num">GMV</th><th className="num">Ad-driven</th>
                  <th style={{ width: 120 }}>Ad share</th><th className="num">7d trend</th><th className="num">Views</th>
                </tr>
              </thead>
              <tbody>
                {(videosQ.data || []).map((v) => (
                  <tr key={v.video_id}>
                    <td className="tight">
                      {v.tiktok_url
                        ? <a href={v.tiktok_url} target="_blank" rel="noreferrer" className="truncate" style={{ display: 'block' }}>
                            {v.title || v.video_id}
                          </a>
                        : <span className="truncate" style={{ display: 'block' }}>{v.title || v.video_id}</span>}
                    </td>
                    <td className="tight muted">@{v.creator_handle}</td>
                    <td className="num tight muted">{v.age_days == null ? '—' : `${v.age_days}d`}</td>
                    <td className="num tight"><strong>{moneyExact(v.gmv, cur)}</strong></td>
                    <td className="num tight" style={{ color: 'var(--paid)' }}>{moneyExact(v.paid_gmv, cur)}</td>
                    <td className="tight">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <MiniBar value={v.paid_share} />
                        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{pct(v.paid_share, 0)}</span>
                      </div>
                    </td>
                    <td className="num tight"><Trend value={v.trend_pct} /></td>
                    <td className="num tight muted">{v.views == null ? '—' : Number(v.views).toLocaleString()}</td>
                  </tr>
                ))}
                {!videosQ.data?.length && <tr><td colSpan={8} className="muted" style={{ padding: 18 }}>No videos in this period.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        <div className="pad" style={{ paddingTop: 0 }}>
          <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>
            A dash under 7d trend means the video had no revenue in the prior week, so there is no baseline to
            compare against — not that it fell to zero. Age and views come from Reacher&rsquo;s video feed;
            revenue always comes from order lines.
          </p>
        </div>
      </Card>
    </div>
  );
}
