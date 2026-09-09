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
//
// ── WHAT THE REDESIGN CHANGED ──────────────────────────────────────────────
// Presentation only. Every step, limit, default, confirmation and action is the
// one that was here before: the five numbered steps are Panels, the two lists
// are `table.data` with a sticky identity column, and the warnings are Notices
// so a sentence renders as a sentence instead of as spaced fragments.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { creatorGrowth, allCreatorGrowth, productCatalog, outreach, outreachLog } from '../lib/api.js';
import { addDays } from '../lib/window.js';
import { scopedTo } from '../lib/scope.js';
import ReportToolbar from '../components/ReportToolbar.jsx';
import {
  Panel, PageHeader, Notice, Skeleton, EmptyState, money, pct,
} from '../components/ui.jsx';

const MAX_MESSAGE = 500;
const MAX_NAME = 30;

/** The creator shortlist is ALWAYS a fixed 30-day pair. It is not the reporting
 *  window, and the report-length buttons do not move it — only the end date
 *  does. `shop_creator_growth` takes p_window_days = 30 and p_end = scope.end,
 *  so these are the two windows it actually compares. */
const TARGETING_DAYS = 30;
const targetingBasis = (end) => ({
  recentStart: addDays(end, -(TARGETING_DAYS - 1)),
  recentEnd: end,
  priorStart: addDays(end, -(TARGETING_DAYS * 2 - 1)),
  priorEnd: addDays(end, -TARGETING_DAYS),
});
const shortRange = (a, b) => `${a.slice(5)} → ${b.slice(5)}`;

/** `dry_run` is a wire value, not a label. Sentence case, once, for both uses. */
const actionLabel = (a) => String(a || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export default function OutreachPage() {
  const { shop, scope } = useOutletContext();
  const [params] = useSearchParams();
  const end = scope.end;
  const cur = shop.currency || 'USD';

  // ── the shortlist ─────────────────────────────────────────────────────────
  const basis = targetingBasis(end);
  const [growth, setGrowth] = useState(2);
  const [organicOnly, setOrganicOnly] = useState(false);
  const [allShops, setAllShops] = useState(false);
  const [picked, setPicked] = useState(null);      // null = "all of them"
  const [pasted, setPasted] = useState('');

  // Across-all-shops is a DISCOVERY view. The automation itself still belongs to
  // one shop, so a creator who grew for a different shop is a colder invitation
  // than one who grew for this one — flagged below rather than hidden.
  const growthQ = useQuery({
    queryKey: ['growth', allShops ? 'all' : shop.id, end, growth],
    queryFn: () => (allShops
      ? allCreatorGrowth(end, { minGrowth: growth, maxGmv: null })
      : creatorGrowth(shop.id, end, { minGrowth: growth, maxGmv: null })),
  });
  const productsQ = useQuery({
    queryKey: ['catalog', shop.id],
    queryFn: () => productCatalog(shop.id),
  });
  const logQ = useQuery({ queryKey: ['outreachlog', shop.id], queryFn: () => outreachLog(shop.id) });

  /** Titles that appear more than once in the catalogue, so those rows can show
      the product id that distinguishes them. Computed over the whole catalogue,
      not the rendered page, or a duplicate split across a scroll looks unique. */
  const dupTitles = useMemo(() => {
    const seen = new Map();
    for (const p of productsQ.data || []) {
      const t = p.title || p.product_id;
      seen.set(t, (seen.get(t) || 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([t]) => t));
  }, [productsQ.data]);

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

  // ── A DRAFT DOES NOT FOLLOW YOU TO ANOTHER SHOP ───────────────────────────
  // `chosenProducts` is keyed by product_id and `picked` by creator handle, and
  // both belong to the shop they were chosen in. An invitation for Biostime
  // built out of Cutler's product ids is the kind of mistake that is only found
  // after it has been sent.
  //
  // Today that cannot happen, but NOT because of anything on this page: Shell
  // keys the outlet wrapper by shop id, so switching shops unmounts this
  // component and every selection dies with it. That key exists for an
  // unrelated reason — stopping one shop's figures being shown under another's
  // name — and if it is ever removed this page would silently start carrying
  // products across. So the invariant is enforced here as well, where it
  // belongs, rather than left resting on a detail of the shell. Browser QA
  // confirms the clearing; this effect is the guard for the day the key goes.
  const draftShop = useRef(shop.id);
  useEffect(() => {
    if (draftShop.current === shop.id) return;
    draftShop.current = shop.id;
    setChosenProducts({});
    setPicked(null);
    setPasted('');
    setCreated(null);
    setResult(null);
  }, [shop.id]);
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

  const mixedShops = allShops && candidates.some((c) => c.shops && !c.shops.includes(shop.shop_name));

  // While the shortlist is still loading, `selected` holds only pasted handles,
  // so a count printed now is not the count that is about to appear. A number
  // that changes under the reader is worse than no number, so it is withheld
  // rather than shown as zero.
  const countKnown = !growthQ.isLoading;

  return (
    <>
      <PageHeader
        title="Outreach"
        sub={`${shop.shop_name} · the only page here that acts outside the app — everything else reads, this one can create and start real invitations in Reacher.`}
        right={<ReportToolbar scope={scope} shop={shop} />}
      />

      <Notice tone="warn">
        <p>
          <strong>This page can send real messages to real creators.</strong> Creating an automation
          does <em>not</em> send anything — it only sends once you press Start, and that is a separate,
          deliberate action. Validate first: a dry run asks Reacher to check the whole thing and save
          nothing. Every action here is recorded against your name.
        </p>
        {/* Said BEFORE the switch rather than after it. A notice that appears
            once the work is already gone explains a loss; this prevents one.
            The draft cannot cross shops — see the guard above — so the only
            thing left to get right is that nobody is surprised by it. */}
        <p>
          Everything you build here belongs to <strong>{shop.shop_name}</strong>. Creators and products are
          that shop's, so changing shop in the header <strong>clears the selected creators and products</strong>.
          Finish or send an invitation before switching.
        </p>
      </Notice>

      {/* ── 1. who ────────────────────────────────────────────────────────── */}
      <Panel
        title="1 · Who to invite"
        sub="Creators from our own growth analysis. Nothing here exists in Reacher's targeting filters."
        bodyPad={false}
        right={(
          <>
            {countKnown
              ? <span className="status status-accent">{selected.length} selected</span>
              : <span className="skel" style={{ display: 'inline-block', height: 20, width: 88 }} />}
            <button className="btn btn-sm" onClick={() => setPicked(null)}>Select all</button>
            <button className="btn btn-sm" onClick={() => setPicked(new Set())}>Clear</button>
          </>
        )}
      >
        <div className="panel-body" style={{ paddingBottom: 12 }}>
          <div className="toolbar" style={{ alignItems: 'flex-end' }}>
            <label className="field">
              <span>Grew at least</span>
              <select className="input" value={growth}
                onChange={(e) => { setGrowth(Number(e.target.value)); setPicked(null); }}>
                {[1.5, 2, 3, 5].map((g) => <option key={g} value={g}>{g}×</option>)}
              </select>
            </label>

            <label className="row" style={{ flexWrap: 'nowrap', gap: 8, height: 36 }}>
              <input type="checkbox" checked={organicOnly}
                onChange={(e) => { setOrganicOnly(e.target.checked); setPicked(null); }} />
              <span>Fully organic only <span className="muted">(no ad spend behind their growth)</span></span>
            </label>

            <label className="row" style={{ flexWrap: 'nowrap', gap: 8, height: 36 }}>
              <input type="checkbox" checked={allShops}
                onChange={(e) => { setAllShops(e.target.checked); setPicked(null); }} />
              <span>All shops <span className="muted">(not just {shop.shop_name})</span></span>
            </label>
          </div>

          {/* The date control in the header says "Last N days". This list does
              not use N. It is a fixed 30-vs-30 comparison anchored to the end
              date, so switching the report from 7 days to 60 changes every
              other page and leaves this shortlist identical. Saying so here is
              cheaper than letting someone discover it by not noticing. */}
          {/* A LINE, not a paragraph. The dates are the part that gets read;
              why the toolbar does not move them is worth one click, not four
              lines above the list on every visit. */}
          <details className="meta" style={{ margin: '10px 0 0' }}>
            <summary style={{ cursor: 'pointer' }}>
              <strong>Targeting:</strong> {basis.recentStart} → {basis.recentEnd} vs{' '}
              {basis.priorStart} → {basis.priorEnd} · fixed {TARGETING_DAYS} days
            </summary>
            <p style={{ margin: '6px 0 0', maxWidth: '78ch' }}>
              A fixed {TARGETING_DAYS}-day pair anchored to the report <em>end</em> date. The report length
              in the toolbar{scope.custom ? '' : ` (currently ${scope.days} days)`} does not change this
              list — only moving the end date does. Creator growth is measured over a consistent window so
              a shortlist stays comparable between reports of different lengths.
            </p>
          </details>

          {/* An automation belongs to one shop. Inviting someone who grew for a
              different shop is legitimate, but it is a colder ask than inviting
              someone already selling this brand — worth saying before they send. */}
          {mixedShops && (
            <div style={{ marginTop: 12 }}>
              <Notice tone="info">
                This list spans every shop, but the automation you are building belongs to{' '}
                <strong>{shop.shop_name}</strong>. Creators marked in amber grew for a different brand — they
                can still be invited, it is simply a colder ask than inviting someone already selling this one.
              </Notice>
            </div>
          )}
        </div>

        {growthQ.isLoading ? (
          <div className="panel-body" style={{ paddingTop: 0 }}><Skeleton h={200} /></div>
        ) : !candidates.length ? (
          /* TWO DIFFERENT EMPTIES, and advising a lower threshold is wrong for
             one of them. If the growth query itself returned nothing, there is
             no creator data for these dates at all and no filter setting will
             produce a row — telling someone to lower the multiple sends them
             round a loop that cannot end. Only when rows EXIST but none survive
             the filter is the threshold the thing to change. */
          (growthQ.data || []).length === 0 ? (
            <EmptyState title="No creator data for these dates">
              Nothing has been collected for {basis.priorStart} → {basis.recentEnd}
              {allShops ? ' across any shop' : ` for ${shop.shop_name}`}, so there is no growth to compare and
              no shortlist to build. This is missing data, not an absence of growth — changing the growth
              multiple will not produce rows. Check <Link to={scopedTo('/data', params)}>Data status</Link>,
              or paste handles from a sheet below.
            </EmptyState>
          ) : (
            <EmptyState title="No creators match this filter">
              {(growthQ.data || []).length} creator(s) have data for {basis.priorStart} → {basis.recentEnd},
              but none grew at least {growth}× between {basis.priorStart} → {basis.priorEnd} and{' '}
              {basis.recentStart} → {basis.recentEnd}
              {organicOnly ? ', with ad-driven growth excluded' : ''}. Lower the growth multiple
              {organicOnly ? ', untick "fully organic only"' : ''}, or paste handles from a sheet below.
            </EmptyState>
          )
        ) : (
          <div className="tablewrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="data fixed">
              <colgroup>
                <col />
                {allShops && <col style={{ width: 160 }} />}
                <col style={{ width: 118 }} />
                <col style={{ width: 118 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 108 }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="sticky-l">Creator</th>
                  {allShops && <th>Grew for</th>}
                  {/* The dates are in the header, not only in the sentence
                      above, because this is the column someone sorts and
                      screenshots. "Last 30d" alone does not say last 30 days
                      of WHAT — and it is not the reporting window. */}
                  <th className="num" title={`${basis.recentStart} → ${basis.recentEnd}`}>
                    Last 30d
                    <span className="meta" style={{ display: 'block', fontWeight: 400 }}>{shortRange(basis.recentStart, basis.recentEnd)}</span>
                  </th>
                  <th className="num" title={`${basis.priorStart} → ${basis.priorEnd}`}>
                    Prior 30d
                    <span className="meta" style={{ display: 'block', fontWeight: 400 }}>{shortRange(basis.priorStart, basis.priorEnd)}</span>
                  </th>
                  <th className="num">Growth</th>
                  <th className="num">Ad-driven</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => {
                  const on = picked === null || picked.has(c.creator_handle);
                  const otherBrand = allShops && c.shops && !c.shops.includes(shop.shop_name);
                  return (
                    <tr key={c.creator_handle}>
                      <td className="sticky-l">
                        <label className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                          <input type="checkbox" checked={on} onChange={() => {
                            const next = new Set(picked === null ? candidates.map((x) => x.creator_handle) : picked);
                            if (on) next.delete(c.creator_handle); else next.add(c.creator_handle);
                            setPicked(next);
                          }} />
                          <span className="truncate">@{c.creator_handle}</span>
                        </label>
                      </td>
                      {allShops && (
                        <td>
                          {otherBrand
                            ? <span className="status status-warn" title={`Grew for ${c.shops}, not ${shop.shop_name}`}>{c.shops}</span>
                            : <span className="muted truncate">{c.shops}</span>}
                        </td>
                      )}
                      <td className="num"><strong>{money(c.recent_gmv, cur)}</strong></td>
                      <td className="num muted">{money(c.prior_gmv, cur)}</td>
                      <td className="num">{Number(c.growth_multiple).toFixed(1)}×</td>
                      <td className="num"
                        title={Number(c.recent_paid_gmv) === 0 ? 'Fully organic — no ad spend behind this growth' : undefined}>
                        {c.recent_paid_share == null ? '—' : pct(c.recent_paid_share, 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="panel-body" style={{ borderTop: '1px solid var(--divider)' }}>
          <label className="field">
            <span>Or paste handles from a sheet</span>
            <textarea className="input" rows={3} style={{ fontFamily: 'var(--mono)' }}
              placeholder="one per line, or comma separated — @ optional"
              value={pasted} onChange={(e) => setPasted(e.target.value)} />
          </label>
          {/* "may be lower than 0" is not a sentence about anything. With
              nothing selected there is no count for Reacher to come back under,
              so the caveat does not apply and is not shown. */}
          <p className="meta" style={{ margin: '6px 0 0' }}>
            Pasted handles are merged with the ticked ones and de-duplicated.
            {!countKnown
              ? ' Reacher silently skips handles it cannot match, so the count it reports back may be lower than the number you have selected.'
              : selected.length > 0
                ? ` Reacher silently skips handles it cannot match, so the count it reports back may be lower than ${selected.length}.`
                : ' No creators are selected yet — tick some above, or paste handles here.'}
          </p>
        </div>
      </Panel>

      {/* ── 2. what ───────────────────────────────────────────────────────── */}
      <Panel title="2 · The invitation" sub="Exactly what the creator sees on the Target Collab card.">
        <div className="stack">
          <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <label className="field">
                <span>Invitation name</span>
                <input className="input" value={name}
                  onChange={(e) => setName(e.target.value)} placeholder="e.g. Rising creators Sep" />
              </label>
              <p className="meta" style={name.length > MAX_NAME
                ? { margin: '4px 0 0', color: 'var(--error)' } : { margin: '4px 0 0' }}>
                {name.length}/{MAX_NAME}
              </p>
            </div>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <label className="field">
                <span>Valid until</span>
                <input className="input" value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)} placeholder="YYYY-MM-DD" />
              </label>
              <p className="meta" style={{ margin: '4px 0 0' }}>
                After this date the invitation stops being offered.
              </p>
            </div>
          </div>

          <div>
            <label className="field" style={{ maxWidth: 360 }}>
              <span>Support contact email</span>
              <input className="input" value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)} placeholder="support@yourbrand.com" />
            </label>
            {/* "neither shop" was written when there were two. There are three,
                and there may be more — a sentence that counts the shops goes
                stale the moment one is added. It names the selected shop instead,
                which is the only one this invitation can belong to anyway. */}
            <p className="meta" style={{ margin: '4px 0 0', maxWidth: '72ch' }}>
              Shown to the creator on the invitation card. Reacher requires it on every Target Collab,
              and <strong>{shop.shop_name}</strong> has no saved default, so it must be entered here each time.
            </p>
          </div>

          <div>
            <label className="field">
              <span>Message</span>
              <textarea className="input" rows={7} value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What the creator reads. Say why this product suits them specifically." />
            </label>
            <p className="meta" style={message.length > MAX_MESSAGE
              ? { margin: '4px 0 0', color: 'var(--error)' } : { margin: '4px 0 0' }}>
              {message.length}/{MAX_MESSAGE}
            </p>
          </div>
        </div>
      </Panel>

      {/* ── 3. products ───────────────────────────────────────────────────── */}
      <Panel
        title="3 · Products and commission"
        sub="Tick a product and set the commission the creator earns. Entered as a percentage."
        bodyPad={false}
      >
        {productsQ.isLoading ? (
          <div className="panel-body"><Skeleton h={160} /></div>
        ) : !productsQ.data?.length ? (
          <EmptyState title="No products in the catalogue">
            This shop has no rows in the product catalogue, so there is nothing to attach a commission to.
          </EmptyState>
        ) : (
          <div className="tablewrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {/* Fixed layout, declared widths. The commission input is the whole
                point of this table and it was being pushed off the right edge by
                whichever product happened to have the longest title. */}
            <table className="data fixed">
              <colgroup>
                <col />
                <col style={{ width: 120 }} />
                <col style={{ width: 148 }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="sticky-l">Product</th>
                  <th className="num">Price</th>
                  <th>Commission %</th>
                </tr>
              </thead>
              <tbody>
                {(productsQ.data || []).map((p) => {
                  const on = p.product_id in chosenProducts;
                  const label = p.title || p.product_id;
                  return (
                    <tr key={p.product_id}>
                      <td className="sticky-l">
                        <label className="row" style={{ flexWrap: 'nowrap', gap: 8 }} title={label}>
                          <input type="checkbox" checked={on} onChange={() => setChosenProducts((prev) => {
                            const next = { ...prev };
                            if (on) delete next[p.product_id]; else next[p.product_id] = 20;
                            return next;
                          })} />
                          <span style={{ minWidth: 0 }}>
                            {/* TWO LINES, not one truncated line. The column has
                                a declared width now, so a long name can wrap
                                without moving the price or the commission input
                                — and two lines of a product name is usually the
                                whole distinguishing part of it. */}
                            <span className="clamp2">{label}</span>
                            {/* Two catalogue rows can carry the SAME title and be
                                different products. Ticking one of a pair of
                                identical-looking lines is a coin flip, so the
                                duplicates — and only the duplicates — show the id
                                that tells them apart. */}
                            {dupTitles.has(label) && (
                              <span className="meta mono">{p.product_id}</span>
                            )}
                          </span>
                        </label>
                      </td>
                      <td className="num muted">{p.min_price == null ? '—' : money(p.min_price, cur)}</td>
                      <td>
                        {on && (
                          <input className="input" type="number" min="0" max="90" step="0.5"
                            aria-label={`Commission for ${label}`}
                            style={{ width: 96 }}
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
      </Panel>

      {/* ── 4. pace ───────────────────────────────────────────────────────── */}
      <Panel title="4 · Pace" sub="How fast it works through the list once started.">
        <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <label className="field" style={{ maxWidth: 140 }}>
              <span>Creators per day</span>
              <input className="input" type="number" min="1" max="200"
                value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} />
            </label>
            {/* Two different limits used to be described by one sentence, which
                read as "you can only contact 200 creators". They are a rate and
                a list size, and confusing them changes what someone thinks the
                tool can do. */}
            {!countKnown ? (
              <p className="meta" style={{ margin: '6px 0 0' }}>
                The creator list is still loading, so how long it takes to work through cannot be worked out yet.
              </p>
            ) : !Number(dailyCap) ? (
              // A blank field has no rate, so it gets a dash and a reason —
              // printing "0/day" would state a pace nobody chose.
              <p className="meta" style={{ margin: '6px 0 0' }}>
                {selected.length} creators at —/day: enter a daily rate to see how long the list takes.
              </p>
            ) : (
              // An empty list takes no days. Math.max(1, …) floored the estimate
              // at one, so zero creators read as "1 day(s) to work through the
              // list" — a duration for work that does not exist.
              selected.length === 0 ? (
                <p className="meta" style={{ margin: '6px 0 0' }}>
                  No creators selected, so there is nothing to pace yet.
                </p>
              ) : (
                <p className="meta" style={{ margin: '6px 0 0' }}>
                  {selected.length} creators at {dailyCap}/day ≈{' '}
                  <strong>{Math.ceil(selected.length / Math.max(1, Number(dailyCap)))} day(s)</strong> to work through the list.
                </p>
              )
            )}
            {/* The caps are load-bearing but they are not what you came here to
                read, so they sit one click away rather than as a paragraph. */}
            <details style={{ marginTop: 6 }}>
              <summary className="meta" style={{ cursor: 'pointer' }}>What the limits are, and whose they are</summary>
              <p className="meta" style={{ margin: '6px 0 0', maxWidth: '72ch' }}>
                Limits: <strong>200 per day</strong>, <strong>500 creators per automation</strong>. Both are our own
                safety caps, not Reacher&rsquo;s — your account allows far more (a past run reached 10,699 creators).
                Ask and they can be raised.
              </p>
            </details>
          </div>

          <label className="row" style={{ flex: '1 1 260px', alignItems: 'flex-start', flexWrap: 'nowrap', gap: 8, paddingTop: 22 }}>
            <input type="checkbox" checked={excludeMessaged}
              onChange={(e) => setExcludeMessaged(e.target.checked)} />
            <span>
              Skip creators already messaged
              <span className="meta" style={{ display: 'block' }}>
                Recommended — avoids contacting the same person twice.
              </span>
            </span>
          </label>
        </div>
      </Panel>

      {/* ── 5. act ────────────────────────────────────────────────────────── */}
      <Panel title="5 · Validate, then create" sub="Creating does not send. Starting sends.">
        <div className="stack">
          {problems.length > 0 && (
            <Notice tone="warn">
              <p><strong>Not ready yet:</strong></p>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {problems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </Notice>
          )}

          <div className="row">
            <button className="btn" disabled={!ready || busy} onClick={() => run('dry_run')}>
              {busy === 'dry_run' ? 'Validating…' : 'Dry run — validate, save nothing'}
            </button>
            <button className="btn btn-primary" disabled={!ready || busy} onClick={() => {
              if (window.confirm(
                `Create a Target Collab automation for ${selected.length} creators?\n\n`
                + 'This does NOT send anything. It creates the automation in Reacher, stopped.\n'
                + 'Nothing goes out until you press Start.',
              )) run('create');
            }}>
              {busy === 'create'
                ? 'Creating…'
                : countKnown
                  ? `Create for ${selected.length} creators (stopped)`
                  : 'Create the automation (stopped)'}
            </button>
          </div>

          {created && (
            <div style={{ borderTop: '1px solid var(--divider)', paddingTop: 16 }}>
              <h3 className="section-title">Automation #{created}</h3>
              <p className="meta" style={{ margin: '2px 0 0', maxWidth: '72ch' }}>
                It exists in Reacher and is stopped. Nothing goes out until you press Start sending.
              </p>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn" disabled={busy} onClick={() => control('status')}>Check status</button>
                <button className="btn" disabled={busy}
                  style={{ borderColor: 'var(--error)', color: 'var(--error)' }}
                  onClick={() => {
                    if (window.confirm(
                      `START automation #${created}?\n\n`
                      + `This WILL begin sending invitations to ${selected.length} creators, `
                      + `up to ${dailyCap} per day. It cannot be unsent.`,
                    )) control('start');
                  }}>
                  Start sending
                </button>
                <button className="btn" disabled={busy} onClick={() => control('stop')}>Stop</button>
              </div>
            </div>
          )}

          {result && (
            // The notice says what happened, in a sentence. The raw response is
            // evidence, not prose, so it sits in a disclosure underneath rather
            // than as a scrolling block inside the sentence.
            <div>
              <Notice tone={result.ok ? 'info' : 'warn'}>
                <p>
                  <strong>{actionLabel(result.action)}</strong>{' '}
                  {result.ok ? 'succeeded.' : 'failed.'}
                </p>
                {result.note && <p style={{ margin: '4px 0 0' }}>{result.note}</p>}
              </Notice>
              <details style={{ marginTop: 8 }}>
                <summary className="meta" style={{ cursor: 'pointer' }}>
                  Raw response from Reacher
                </summary>
                <pre className="mono" style={{
                  margin: '8px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  maxHeight: 220, overflow: 'auto', padding: 8,
                  background: 'var(--surface)', border: '1px solid var(--divider)',
                  borderRadius: 'var(--r-control)',
                }}>
                  {JSON.stringify(result.data ?? result.error ?? result, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="History" sub="Every dry run, creation, start and stop — who did it and when." bodyPad={false}>
        {logQ.isLoading ? (
          <div className="panel-body"><Skeleton h={100} /></div>
        ) : !logQ.data?.length ? (
          <EmptyState title="Nothing yet">
            Dry runs, creations, starts and stops are recorded here as they happen, against the name of
            whoever ran them.
          </EmptyState>
        ) : (
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="sticky-l">When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Detail</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {(logQ.data || []).map((a) => (
                  <tr key={a.id}>
                    <td className="sticky-l muted" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(a.started_at).toLocaleString()}
                    </td>
                    <td className="muted truncate">{a.actor_email}</td>
                    <td><strong>{actionLabel(a.action)}</strong></td>
                    <td className="muted">
                      {a.detail?.recipients != null ? `${a.detail.recipients} creators` : ''}
                      {a.detail?.automation_id ? `#${a.detail.automation_id}` : ''}
                      {a.detail?.daily_cap ? ` · ${a.detail.daily_cap}/day` : ''}
                    </td>
                    <td>
                      {a.succeeded == null ? <span className="muted">—</span>
                        : <span className={`status status-${a.succeeded ? 'ok' : 'bad'}`}>{a.succeeded ? 'Ok' : 'Failed'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
