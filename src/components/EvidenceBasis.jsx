// How each pound of revenue was established.
//
// ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
// Not a second decomposition of revenue. The channel breakdown above already
// splits the money; this re-labels those same pounds by how well each is
// evidenced. Every row in the partition is money the channel view has already
// counted, and the amounts sum to the same component total.
//
// That distinction is the whole reason this component is careful. Migration 022
// exists because an affiliate excess was added to a total that already
// contained it, and every reported gap came out exactly twice the real one. A
// basis view that looked like extra revenue would be the same mistake with a
// new name.
//
// ── AND THE RESIDUAL SITS OUTSIDE IT ───────────────────────────────────────
// Components and the source total disagree by a small amount. That is shown as
// its own line, visibly outside the partition, rather than folded into a bucket
// — because folding it in would make the buckets sum to the source total by
// construction and the split would look exact when it is not.
import { useQuery } from '@tanstack/react-query';
import { Panel, Notice, Skeleton, Hint } from './ui.jsx';
import { money, pct } from '../lib/api.js';
import { attributionBasis, BASIS_TONE } from '../lib/loopApi.js';

const BASIS_ORDER = ['measured', 'estimated', 'unclassified', 'modelled'];

const BASIS_HEADING = {
  measured: 'Measured',
  estimated: 'Estimated',
  unclassified: 'Unclassified',
  modelled: 'Modelled',
};

const BASIS_SUB = {
  measured: 'read directly from a source',
  estimated: 'a documented allocation, not an observation',
  unclassified: 'held, but we cannot say which',
  modelled: 'produced by a versioned model',
};

export default function EvidenceBasis({ shop, scope }) {
  const cur = shop.currency || 'USD';
  const q = useQuery({
    queryKey: ['basis', shop.id, scope.start, scope.end],
    queryFn: () => attributionBasis(shop.id, scope.start, scope.end),
  });

  const rows = q.data || [];
  const partition = rows.filter((r) => r.is_partition);
  const residual = rows.find((r) => !r.is_partition);
  const partitionTotal = partition.reduce((a, r) => a + Number(r.amount || 0), 0);

  const byBasis = BASIS_ORDER.map((b) => ({
    basis: b,
    rows: partition.filter((r) => r.basis === b),
    total: partition.filter((r) => r.basis === b)
      .reduce((a, r) => a + Number(r.amount || 0), 0),
  })).filter((g) => g.rows.length > 0);

  return (
    <Panel
      title="How each figure was established"
      sub="The same revenue as above, re-labelled by how well it is evidenced. Not additional revenue."
    >
      {q.isLoading && <Skeleton h={200} />}
      {q.error && <Notice tone="error">Could not load the evidence basis: {q.error.message}</Notice>}

      {!q.isLoading && !q.error && rows.length > 0 && (
        <>
          <div className="tablewrap">
            <table className="table">
              <colgroup>
                <col style={{ width: '34%' }} /><col style={{ width: '16%' }} />
                <col style={{ width: '12%' }} /><col style={{ width: '12%' }} />
                <col style={{ width: '26%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="sticky-l">Component</th>
                  <th className="num">Amount</th>
                  {/* TWO DENOMINATORS, BOTH NAMED. They differ by exactly the
                      residual, and showing one without saying which is how 98%
                      quietly becomes 100%. */}
                  <th className="num">
                    of components
                    <Hint text="Share of what our own breakdown adds up to." />
                  </th>
                  <th className="num">
                    of shop GMV
                    <Hint text="Share of what the source says the shop earned. Differs from the column beside it by exactly the residual." />
                  </th>
                  <th>What that means</th>
                </tr>
              </thead>
              <tbody>
                {byBasis.map((g) => (
                  <>
                    <tr key={g.basis} className="rowgroup">
                      <td className="sticky-l" colSpan={5}>
                        <span className={`status status-${BASIS_TONE[g.basis] || 'info'}`}>
                          {BASIS_HEADING[g.basis]}
                        </span>
                        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                          {BASIS_SUB[g.basis]} · {money(g.total, cur)}
                        </span>
                      </td>
                    </tr>
                    {g.rows.map((r) => (
                      <tr key={`${r.basis}-${r.component}`}>
                        <td className="sticky-l">
                          <span className="clamp2" style={{ paddingLeft: 12 }}>{r.component}</span>
                        </td>
                        <td className="num">{money(r.amount, cur)}</td>
                        <td className="num muted">
                          {r.share_of_components == null ? '—' : pct(r.share_of_components, 1)}
                        </td>
                        <td className="num muted">
                          {r.share_of_source == null ? '—' : pct(r.share_of_source, 1)}
                        </td>
                        <td><span className="clamp2 meta">{r.meaning}</span></td>
                      </tr>
                    ))}
                  </>
                ))}

                <tr style={{ borderTop: '2px solid var(--divider)' }}>
                  <td className="sticky-l"><strong>Components total</strong></td>
                  <td className="num"><strong>{money(partitionTotal, cur)}</strong></td>
                  <td className="num muted">100%</td>
                  <td className="num muted" />
                  <td className="meta">
                    Every pound above is counted once. These are the same pounds the
                    channel breakdown shows, labelled by evidence.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* OUTSIDE THE PARTITION, AND SAYING SO EITHER WAY.
              This originally rendered nothing when the residual was zero, which
              looked identical to the panel having no opinion. Cutler reconciles
              to the cent, and that is a fact worth stating — an operator should
              be able to tell "they agree exactly" from "we did not check". */}
          {residual && Math.abs(Number(residual.amount)) > 0.01 ? (
            <Notice tone={Math.abs(Number(residual.share_of_source)) > 0.1 ? 'warn' : 'info'}>
              <strong>Not part of the split: {money(residual.amount, cur)}</strong>{' '}
              ({residual.share_of_source == null ? '—' : pct(residual.share_of_source, 2)} of shop GMV).
              <p style={{ margin: '6px 0 0' }}>{residual.meaning}</p>
            </Notice>
          ) : (
            <Notice tone="info">
              <strong>Not part of the split: nothing.</strong> The components and the
              source total agree exactly, so every pound above is accounted for once and
              there is no residual to hold outside the partition.
            </Notice>
          )}

          <p className="meta" style={{ marginTop: 'var(--s3)' }}>
            These labels say how a value was produced, not how much to trust it and not
            whether it caused anything. A measured pound and an estimated pound are both
            revenue; they are differently evidenced.
          </p>
        </>
      )}
    </Panel>
  );
}
