// The decision panel — the first thing on the page, because the spec's whole
// premise is that a media buyer should know what to do next inside the first
// screenful, not after reading six charts.
//
// The rules live in src/lib/recommend.js and are pure and unit-tested. This
// file only renders what they returned. It deliberately does no filtering,
// ranking or wording of its own: if a rule stayed silent, the screen stays
// silent too, and there is exactly one place to look for why.
import { recommend } from '../lib/recommend.js';
import { Basis } from './ui.jsx';

const ICON = { critical: '⛔', warning: '⚠', info: 'ℹ', good: '✓' };

export default function Decisions({ facts, loading }) {
  if (loading) {
    return (
      <div className="card pad">
        <div className="k">What to do next</div>
        <div className="skel" style={{ height: 92, marginTop: 12 }} />
      </div>
    );
  }

  const recs = recommend(facts);
  if (!recs.length) {
    // Not "everything is fine" — there was nothing to reason over. Saying
    // "no issues" here would be a claim we have not earned.
    return (
      <div className="card pad">
        <div className="k">What to do next</div>
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
          Not enough data in this window to reach a conclusion. Sync a shop, or widen the range.
        </p>
      </div>
    );
  }

  const worst = recs[0].severity;
  return (
    <div className="card pad">
      <div className="hd" style={{ marginBottom: 12 }}>
        <h2>What to do next</h2>
        <span className="sub">
          {recs.length} finding{recs.length > 1 ? 's' : ''}, most consequential first
          {worst === 'good' ? '' : ' · ranked by money at stake'}
        </span>
      </div>

      {recs.map((r) => (
        <div key={r.id} className={`rec rec-${r.severity}`}>
          <div className="icon">{ICON[r.severity]}</div>
          <div style={{ minWidth: 0 }}>
            <h4>{r.title} <Basis kind={r.basis} /></h4>
            <p>{r.finding}</p>
            <div className="do"><b>Do:</b> {r.action}</div>
            {r.evidence?.length > 0 && (
              <div className="ev">{r.evidence.map((e, i) => <span key={i}>{e}</span>)}</div>
            )}
          </div>
        </div>
      ))}

      <p className="muted" style={{ fontSize: 11.5, margin: '14px 0 0' }}>
        Every finding above is produced by a written rule from the numbers shown beside it — no model
        decides anything here. Each rule stays silent when its evidence is too thin to support a
        conclusion, so an empty panel means &ldquo;nothing to say&rdquo;, not &ldquo;nothing checked&rdquo;.
        This tool recommends; a person acts. It never writes to TikTok.
      </p>
    </div>
  );
}
