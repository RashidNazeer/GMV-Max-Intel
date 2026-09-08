// Outreach — build a Target Collab automation from our own creator analysis.
//
// This is the only page in the app that can cause something to happen outside
// it. Everything else reads. So the design is deliberately slower than it needs
// to be: you validate, then you create, then — separately, later, on purpose —
// you start.
//
// The Reacher key is not here and never can be. Every call goes to the
// `outreach` edge function, which checks the caller is the Boss, clamps the
// recipient count and daily rate, and writes an audit row before it acts.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase.js';
import { creatorGrowth, productCatalog, outreach, outreachLog } from '../lib/api.js';
import { Card, Stat, Note, Skeleton, Empty, money, pct } from '../components/ui.jsx';

const MAX_MESSAGE = 500;
const MAX_NAME = 30;

export default function OutreachPage({ shop, end }) {
  const cur = shop.currency || 'USD';

  // ── the shortlist ─────────────────────────────────────────────────────────
  const [growth, setGrowth] = useState(2);
  const [organicOnly, setOrganicOnly] = useState(false);
  const [picked, setPicked] = useState(null);      // null = "all of them"
  const [pasted, setPasted] = useState('');

  const growthQ = useQuery({
    queryKey: ['growth', shop.id, end, growth],
    queryFn: () => creatorGrowth(shop.id, end, { minGrowth: growth, maxGmv: null }),
  });
  const productsQ = useQuery({
    queryKey: ['catalog', shop.id],
    queryFn: () => productCatalog(shop.id),
  });
  const logQ = useQuery({ queryKey: ['outreachlog', shop.id], queryFn: () => outreachLog(shop.id) });

  const candidates = useMemo(() => {
    const rows = growthQ.data || [];
    return organicOnly ? rows.filter((r) => Number(r.recent_paid_gmv) === 0) : rows;
  }, [growthQ.data, organicOnly]);

  const selected = useMemo(() => {
    const fromList = candidates
      .filter((c) => picked === null || picked.has(c.creator_handle))
      .map((c) => c.creator_handle);
    const fromPaste = pasted.split(/[\s,;]+/).map((h) => h.trim().replace(/^@+/, '')).filter(Boolean);
    return Array.from(new Set([...fromList, ...fromPaste]));
  }, [candidates, picked, pasted]);

  // ── the invitation ────────────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  // ISO, not MM/DD/YYYY. Reading an automation back gives "09/08/2026", but the
  // create endpoint rejects that format outright — confirmed by a dry run that
  // returned "valid_until: Input should be a valid date". Read shape and write
  // shape differ here, as they do for `message` and `content_type`.
  const [validUntil, setValidUntil] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });
  const [chosenProducts, setChosenProducts] = useState({});   // product_id -> commission %
  const [supportEmail, setSupportEmail] = useState('');
  const [dailyCap, setDailyCap] = useState(25);
  const [excludeMessaged, setExcludeMessaged] = useState(true);

  const products = Object.entries(chosenProducts)
    .filter(([, v]) => v !== '' && Number.isFinite(Number(v)))
    .map(([product_id, v]) => ({ product_id, commission_rate: Number(v) }));

  // ── running it ────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [created, setCreated] = useState(null);
  // One key per composed automation, so a double-click cannot make two.
  const idempotencyKey = useMemo(
    () => `${shop.id}:${name}:${selected.length}:${products.map((p) => p.product_id).join('-')}`,
    [shop.id, name, selected.length, products],
  );

  const problems = [];
  if (!selected.length) problems.push('No creators selected.');
  if (!name.trim()) problems.push('Invitation name is required.');
  if (name.length > MAX_NAME) problems.push(`Invitation name is ${name.length} characters — the limit is ${MAX_NAME}.`);
  if (!message.trim()) problems.push('Message is required.');
  if (message.length > MAX_MESSAGE) problems.push(`Message is ${message.length} characters — the limit is ${MAX_MESSAGE}.`);
  if (!products.length) problems.push('Choose at least one product and set its commission.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(supportEmail.trim())) {
    problems.push('A support contact email is required — creators see it on the invitation card.');
  }
  const ready = problems.length === 0;

  async function run(action) {
    setBusy(action); setResult(null);
    try {
      const payload = {
        handles: selected,
        automation_name: name.trim(),
        invitation_name: name.trim(),
        invitation_message: message,
        valid_until: validUntil,
        products,
        support_email: supportEmail.trim(),
        daily_cap: Number(dailyCap),
        exclude_previously_messaged: excludeMessaged,
        idempotency_key: idempotencyKey,
      };
      const res = await outreach({ action, shop_id: shop.id, payload });
      setResult({ action, ...res });
      if (action === 'create' && res.ok) {
        const id = res.data?.data?.automation_id ?? res.data?.automation_id ?? null;
        setCreated(id);
      }
      logQ.refetch();
    } catch (e) {
      setResult({ action, ok: false, error: e.message });
    } finally { setBusy(null); }
  }

  async function control(action) {
    if (!created) return;
    setBusy(action); setResult(null);
    try {
      const res = await outreach({ action, shop_id: shop.id, automation_id: String(created) });
      setResult({ action, ...res });
      logQ.refetch();
    } catch (e) { setResult({ action, ok: false, error: e.message }); }
    finally { setBusy(null); }
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <Note tone="warn">
        <div>
          <strong>This page can send real messages to real creators.</strong>
          <div style={{ marginTop: 4 }}>
            Creating an automation does <em>not</em> send anything — it only sends once you press Start, and
            that is a separate, deliberate action. Validate first: a dry run asks Reacher to check the whole
            thing and save nothing. Every action here is recorded against your name.
          </div>
        </div>
      </Note>

      {/* ── 1. who ────────────────────────────────────────────────────────── */}
      <Card title={`1 · Who to invite — ${selected.length} selected`}
        sub="Creators from our own growth analysis. Nothing here exists in Reacher's targeting filters.">
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <label style={{ fontSize: 13 }}>
            Grew at least{' '}
            <select className="input" value={growth} onChange={(e) => { setGrowth(Number(e.target.value)); setPicked(null); }}>
              {[1.5, 2, 3, 5].map((g) => <option key={g} value={g}>{g}×</option>)}
            </select>
          </label>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 7 }}>
            <input type="checkbox" checked={organicOnly}
              onChange={(e) => { setOrganicOnly(e.target.checked); setPicked(null); }} />
            Fully organic only <span className="muted">(no ad spend behind their growth)</span>
          </label>
          <div className="spacer" />
          <button className="btn" onClick={() => setPicked(null)}>Select all</button>
          <button className="btn" onClick={() => setPicked(new Set())}>Clear</button>
        </div>

        {growthQ.isLoading ? <Skeleton h={200} /> : !candidates.length ? (
          <p className="muted" style={{ fontSize: 13 }}>No creators match this filter in the last 30 days.</p>
        ) : (
          <div className="scroll" style={{ maxHeight: 320 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 34 }}></th><th>Creator</th>
                  <th className="num">Last 30d</th><th className="num">Prior 30d</th>
                  <th className="num">Growth</th><th className="num">Ad-driven</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => {
                  const on = picked === null || picked.has(c.creator_handle);
                  return (
                    <tr key={c.creator_handle}>
                      <td className="tight">
                        <input type="checkbox" checked={on} onChange={() => {
                          const next = new Set(picked === null ? candidates.map((x) => x.creator_handle) : picked);
                          on ? next.delete(c.creator_handle) : next.add(c.creator_handle);
                          setPicked(next);
                        }} />
                      </td>
                      <td className="tight">@{c.creator_handle}</td>
                      <td className="num tight"><strong>{money(c.recent_gmv, cur)}</strong></td>
                      <td className="num tight muted">{money(c.prior_gmv, cur)}</td>
                      <td className="num tight">{Number(c.growth_multiple).toFixed(1)}×</td>
                      <td className="num tight" style={Number(c.recent_paid_gmv) === 0 ? { color: 'var(--organic)' } : undefined}>
                        {c.recent_paid_share == null ? '—' : pct(c.recent_paid_share, 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <div className="k">Or paste handles from a sheet</div>
          <textarea className="input" rows={3} style={{ width: '100%', marginTop: 6, fontFamily: 'monospace', fontSize: 12 }}
            placeholder="one per line, or comma separated — @ optional"
            value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <p className="muted" style={{ fontSize: 11.5, margin: '6px 0 0' }}>
            Pasted handles are merged with the ticked ones and de-duplicated. Reacher silently skips handles
            it cannot match, so the count it reports back may be lower than {selected.length}.
          </p>
        </div>
      </Card>

      {/* ── 2. what ───────────────────────────────────────────────────────── */}
      <Card title="2 · The invitation" sub="Exactly what the creator sees on the Target Collab card.">
        <div className="grid g2">
          <div>
            <div className="k">Invitation name</div>
            <input className="input" style={{ width: '100%', marginTop: 5 }} value={name}
              onChange={(e) => setName(e.target.value)} placeholder="e.g. Rising creators Sep" />
            <div className="sub" style={{ color: name.length > MAX_NAME ? 'var(--danger)' : undefined }}>
              {name.length}/{MAX_NAME}
            </div>
          </div>
          <div>
            <div className="k">Valid until</div>
            <input className="input" style={{ width: '100%', marginTop: 5 }} value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)} placeholder="YYYY-MM-DD" />
            <div className="sub">After this date the invitation stops being offered.</div>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="k">Support contact email</div>
          <input className="input" style={{ width: '100%', maxWidth: 360, marginTop: 5 }} value={supportEmail}
            onChange={(e) => setSupportEmail(e.target.value)} placeholder="support@yourbrand.com" />
          <div className="sub">
            Shown to the creator on the invitation card. Reacher requires it on every Target Collab, and
            neither shop has a saved default configured.
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="k">Message</div>
          <textarea className="input" rows={7} style={{ width: '100%', marginTop: 5 }}
            value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="What the creator reads. Say why this product suits them specifically." />
          <div className="sub" style={{ color: message.length > MAX_MESSAGE ? 'var(--danger)' : undefined }}>
            {message.length}/{MAX_MESSAGE}
          </div>
        </div>
      </Card>

      {/* ── 3. products ───────────────────────────────────────────────────── */}
      <Card title="3 · Products and commission"
        sub="Tick a product and set the commission the creator earns. Entered as a percentage.">
        {productsQ.isLoading ? <Skeleton h={160} /> : (
          <div className="scroll" style={{ maxHeight: 260 }}>
            <table>
              <thead>
                <tr><th style={{ width: 34 }}></th><th>Product</th><th className="num">Price</th><th style={{ width: 150 }}>Commission %</th></tr>
              </thead>
              <tbody>
                {(productsQ.data || []).map((p) => {
                  const on = p.product_id in chosenProducts;
                  return (
                    <tr key={p.product_id}>
                      <td className="tight">
                        <input type="checkbox" checked={on} onChange={() => setChosenProducts((prev) => {
                          const next = { ...prev };
                          if (on) delete next[p.product_id]; else next[p.product_id] = 20;
                          return next;
                        })} />
                      </td>
                      <td className="tight"><span className="truncate" style={{ display: 'block' }}>{p.title || p.product_id}</span></td>
                      <td className="num tight muted">{p.min_price == null ? '—' : money(p.min_price, cur)}</td>
                      <td className="tight">
                        {on && (
                          <input className="input" type="number" min="0" max="90" step="0.5" style={{ width: 92 }}
                            value={chosenProducts[p.product_id]}
                            onChange={(e) => setChosenProducts((prev) => ({ ...prev, [p.product_id]: e.target.value }))} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── 4. pace ───────────────────────────────────────────────────────── */}
      <Card title="4 · Pace" sub="How fast it works through the list once started.">
        <div className="grid g3">
          <div>
            <div className="k">Creators per day</div>
            <input className="input" type="number" min="1" max="200" style={{ width: 120, marginTop: 5 }}
              value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} />
            <div className="sub">
              {selected.length} creators ≈ {Math.max(1, Math.ceil(selected.length / Math.max(1, Number(dailyCap))))} day(s).
              Capped at 200 by the server whatever is typed here.
            </div>
          </div>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 22 }}>
            <input type="checkbox" checked={excludeMessaged} onChange={(e) => setExcludeMessaged(e.target.checked)} />
            <span>Skip creators already messaged<br />
              <span className="muted" style={{ fontSize: 11.5 }}>Recommended — avoids contacting the same person twice.</span>
            </span>
          </label>
        </div>
      </Card>

      {/* ── 5. act ────────────────────────────────────────────────────────── */}
      <Card title="5 · Validate, then create" sub="Creating does not send. Starting sends.">
        {problems.length > 0 && (
          <Note tone="warn">
            <div>
              <strong>Not ready yet:</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {problems.map((p, i) => <li key={i} style={{ fontSize: 13 }}>{p}</li>)}
              </ul>
            </div>
          </Note>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="btn" disabled={!ready || busy} onClick={() => run('dry_run')}>
            {busy === 'dry_run' ? 'Validating…' : 'Dry run — validate, save nothing'}
          </button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={() => {
            if (window.confirm(
              `Create a Target Collab automation for ${selected.length} creators?\n\n` +
              `This does NOT send anything. It creates the automation in Reacher, stopped.\n` +
              `Nothing goes out until you press Start.`,
            )) run('create');
          }}>
            {busy === 'create' ? 'Creating…' : `Create for ${selected.length} creators (stopped)`}
          </button>
        </div>

        {created && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
            <div className="k">Automation #{created}</div>
            <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn" disabled={busy} onClick={() => control('status')}>Check status</button>
              <button className="btn" disabled={busy} style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
                onClick={() => {
                  if (window.confirm(
                    `START automation #${created}?\n\n` +
                    `This WILL begin sending invitations to ${selected.length} creators, ` +
                    `up to ${dailyCap} per day. It cannot be unsent.`,
                  )) control('start');
                }}>
                Start sending
              </button>
              <button className="btn" disabled={busy} onClick={() => control('stop')}>Stop</button>
            </div>
          </div>
        )}

        {result && (
          <div style={{ marginTop: 14 }}>
            <Note tone={result.ok ? 'info' : 'warn'}>
              <div style={{ minWidth: 0 }}>
                <strong>{result.ok ? 'OK' : 'Failed'} — {result.action.replace('_', ' ')}</strong>
                {result.note && <div style={{ marginTop: 4 }}>{result.note}</div>}
                <pre style={{
                  marginTop: 8, marginBottom: 0, fontSize: 11, whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word', maxHeight: 220, overflow: 'auto',
                }}>
                  {JSON.stringify(result.data ?? result.error ?? result, null, 2)}
                </pre>
              </div>
            </Note>
          </div>
        )}
      </Card>

      <Card title="History" sub="Every dry run, creation, start and stop — who did it and when." pad={false}>
        {logQ.isLoading ? <div className="pad"><Skeleton h={100} /></div> : (
          <div className="scroll">
            <table>
              <thead>
                <tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th><th>Result</th></tr>
              </thead>
              <tbody>
                {(logQ.data || []).map((a) => (
                  <tr key={a.id}>
                    <td className="tight muted">{new Date(a.started_at).toLocaleString()}</td>
                    <td className="tight muted">{a.actor_email}</td>
                    <td className="tight"><strong>{a.action.replace('_', ' ')}</strong></td>
                    <td className="tight muted">
                      {a.detail?.recipients != null ? `${a.detail.recipients} creators` : ''}
                      {a.detail?.automation_id ? `#${a.detail.automation_id}` : ''}
                      {a.detail?.daily_cap ? ` · ${a.detail.daily_cap}/day` : ''}
                    </td>
                    <td className="tight">
                      {a.succeeded == null ? <span className="muted">—</span>
                        : <span className={`pill ${a.succeeded ? 'pill-ok' : 'pill-bad'}`}>{a.succeeded ? 'ok' : 'failed'}</span>}
                    </td>
                  </tr>
                ))}
                {!logQ.data?.length && <tr><td colSpan={5} className="muted" style={{ padding: 18 }}>Nothing yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
