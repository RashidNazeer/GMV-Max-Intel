// What this integration can and cannot do, and why.
//
// ── WHY THIS IS ON SCREEN AT ALL ───────────────────────────────────────────
// Several things the tool declines to say are declined for a good reason that
// was previously invisible. The creative finding will not call creative the
// constraint; Target ROI headroom will not propose a step; Creative Boost never
// appears as an action. From the outside those look like the tool being
// unhelpful. They are the tool being honest about an integration that does not
// return the evidence those claims would need.
//
// Naming the missing capability, the evidence for that, and the dependency that
// would change it turns "why won't it tell me" into "here is what we would need
// from Reacher" — which is a question somebody can actually go and ask.
import { useQuery } from '@tanstack/react-query';
import { Panel, Notice, Skeleton, Hint } from './ui.jsx';
import { shopCapabilities, CAPABILITY_LABEL } from '../lib/loopApi.js';

const TONE = { supported: 'ok', unavailable: 'bad', unknown: 'warn' };
const WORD = {
  supported: 'Available',
  unavailable: 'Not available',
  // Not "no". The distinction is the point: nobody has been able to check.
  unknown: 'Unverified',
};

export default function CapabilityPanel({ shop }) {
  const q = useQuery({
    queryKey: ['caps', shop?.id],
    queryFn: () => shopCapabilities(shop.id),
    enabled: !!shop?.id,
  });

  const rows = q.data || [];
  const missing = rows.filter((r) => r.state !== 'supported');

  return (
    <Panel
      title="What this integration provides"
      sub="Some findings are withheld because the evidence for them is not available. This is that list."
    >
      {q.isLoading && <Skeleton h={160} />}
      {q.error && <Notice tone="error">Could not load capabilities: {q.error.message}</Notice>}

      {!q.isLoading && !q.error && (
        <>
          {missing.length === 0 ? (
            <Notice tone="info">
              Every capability this product uses is available from the current integration.
            </Notice>
          ) : (
            <p className="meta" style={{ marginTop: 0 }}>
              {missing.length} of {rows.length} are unavailable or unverified. Each one is
              why some specific claim is not being made.
            </p>
          )}

          <div className="tablewrap">
            <table className="table">
              <colgroup>
                <col style={{ width: '26%' }} /><col style={{ width: '13%' }} />
                <col style={{ width: '35%' }} /><col style={{ width: '26%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="sticky-l">Capability</th>
                  <th>State</th>
                  <th>What we observed</th>
                  <th>What would change it</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.capability}-${r.campaign_type}-${i}`}>
                    <td className="sticky-l">
                      <div>{CAPABILITY_LABEL[r.capability] || r.capability}</div>
                      {/* PRODUCT and LIVE GMV Max are different products and are
                          assessed separately — answering for one while a screen
                          shows the other is the confusion this column prevents. */}
                      {r.campaign_type && r.campaign_type !== '*' && (
                        <div className="ident-sub">{r.campaign_type} GMV Max</div>
                      )}
                    </td>
                    <td>
                      <span className={`status status-${TONE[r.state] || 'info'}`}>
                        {WORD[r.state] || r.state}
                      </span>
                      {r.state === 'unknown' && (
                        <Hint text="Not the same as unavailable. Read-only access cannot establish this either way, so it stays unverified until a person confirms it in the platform." />
                      )}
                    </td>
                    <td><span className="clamp2">{r.evidence}</span></td>
                    <td className="muted">
                      <span className="clamp2">{r.dependency || '—'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.length > 0 && (
            <p className="meta" style={{ marginTop: 'var(--s3)' }}>
              Last checked {new Date(
                Math.max(...rows.map((r) => new Date(r.verified_at).getTime())),
              ).toLocaleDateString()}. A capability nobody has re-checked in months is a
              weaker claim than one probed this morning.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
