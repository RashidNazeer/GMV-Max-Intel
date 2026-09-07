// The decision panel — the first thing on the page, because the spec's whole
// premise is that a media buyer should know what to do next inside the first
// screenful, not after reading six charts.
//
// It shows BOTH sides. An earlier version listed only problems, which turned it
// into a complaints box: a shop doing three things well read as nothing but
// faults, and someone deciding where next month's budget goes needs to know
// what to protect as much as what to fix.
//
// The rules live in src/lib/recommend.js and are pure and unit-tested. This
// file only renders what they returned — no filtering, ranking or wording of
// its own. If a rule stayed silent the screen stays silent too, and there is
// exactly one place to look for why.
import { useState } from 'react';
import { recommend, whatsWorking } from '../lib/recommend.js';
import { Basis } from './ui.jsx';

const ICON = { critical: '⛔', warning: '⚠', info: 'ℹ', good: '✓' };

function Finding({ r }) {
  return (
    <div className={`rec rec-${r.severity}`}>
      <div className="icon">{ICON[r.severity]}</div>
      <div style={{ minWidth: 0 }}>
        <h4>{r.title} <Basis kind={r.basis} /></h4>
        <p>{r.finding}</p>
        <div className="do"><b>{r.severity === 'good' ? 'Keep:' : 'Do:'}</b> {r.action}</div>
        {r.evidence?.length > 0 && (
          <div className="ev">{r.evidence.map((e, i) => <span key={i}>{e}</span>)}</div>
        )}
      </div>
    </div>
  );
}

export default function Decisions({ facts, loading }) {
  const [tab, setTab] = useState('fix');

  if (loading) {
    return (
      <div className="card pad">
        <div className="k">What to do next</div>
        <div className="skel" style={{ height: 92, marginTop: 12 }} />
      </div>
    );
  }

  const problems = recommend(facts).filter((r) => r.severity !== 'good');
  const working = whatsWorking(facts);
  const allClear = recommend(facts).filter((r) => r.severity === 'good');

  if (!problems.length && !working.length) {
    // Not "everything is fine" — there was nothing to reason over. Claiming
    // "no issues" here would be a conclusion we have not earned.
    return (
      <div className="card pad">
        <div className="k">What to do next</div>
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
          Not enough data in this window to reach a conclusion. Sync a shop, or widen the range.
        </p>
      </div>
    );
  }

  const shown = tab === 'fix'
    ? (problems.length ? problems : allClear)
    : working;

  return (
    <div className="card pad">
      <div className="hd" style={{ marginBottom: 12 }}>
        <h2>What to do next</h2>
        <span className="sub">Ranked by money at stake · every finding traces to the numbers beside it</span>
      </div>

      <div className="seg" style={{ marginBottom: 14 }}>
        <button onClick={() => setTab('fix')} aria-pressed={tab === 'fix'}>
          Needs attention
          <span className="cnt">{problems.length}</span>
        </button>
        <button onClick={() => setTab('working')} aria-pressed={tab === 'working'}>
          What&rsquo;s working
          <span className="cnt">{working.length}</span>
        </button>
      </div>

      {shown.map((r) => <Finding key={r.id} r={r} />)}

      {!shown.length && (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          {tab === 'working'
            ? 'No strength cleared its evidence bar in this window. That is not the same as nothing going well — it means nothing was measurable enough to state.'
            : 'Nothing needs attention in this window.'}
        </p>
      )}

      <p className="muted" style={{ fontSize: 11.5, margin: '14px 0 0' }}>
        Every finding is produced by a written rule from the numbers shown beside it — no model decides
        anything here. Each rule stays silent when its evidence is too thin, so an empty list means
        &ldquo;nothing to say&rdquo;, not &ldquo;nothing checked&rdquo;. This tool recommends; a person acts.
        It never writes to TikTok.
      </p>
    </div>
  );
}
