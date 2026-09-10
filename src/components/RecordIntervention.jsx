// Record a change that actually happened.
//
// ── WHY THIS IS NOT "MARK AS APPLIED" ──────────────────────────────────────
// A recommendation being accepted is not a change. Somebody still has to open
// TikTok Ads Manager and move the number, and that act is the thing every later
// evaluation depends on. This form records THAT, with three things the old
// applied_value column could not express:
//
//   * a change made with no recommendation behind it. Most useful history is
//     this. Refusing to record it would leave the log describing only the
//     subset the tool happened to suggest.
//   * WHEN, honestly. A person can give a moment; a detected change only ever
//     has an interval between two observations, and nothing here invents one.
//   * a change the guardrails would have blocked. Logging it truthfully is
//     better than losing it — the outcome arrives either way, and without the
//     record it arrives unexplained.
//
// The form deliberately does NOT execute anything. This product does not write
// to TikTok; the operator has already made the change, and this is the receipt.
import { useState } from 'react';
import { Drawer, Notice, Hint } from './ui.jsx';
import { recordIntervention, planOutcomeReview, advanceReview, CONFIRMATION } from '../lib/loopApi.js';

const FIELDS = [
  ['daily_budget', 'Daily budget', 'currency_per_day'],
  ['target_roi', 'Target ROI', 'ratio'],
  ['status', 'Campaign status', null],
  ['creative_replaced', 'Creative replaced', null],
  ['creative_added', 'Creative added', null],
  ['product_price', 'Product price', 'currency'],
  ['other', 'Something else', null],
];

const ENTITY_TYPES = [
  ['campaign', 'A campaign'],
  ['creative', 'A video'],
  ['product', 'A product'],
  ['shop', 'The whole shop'],
];

const todayLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export default function RecordInterventionDialog({ shop, prefill, onClose, onSaved }) {
  const [entityType, setEntityType] = useState(prefill?.entity_type || 'campaign');
  const [entityId, setEntityId] = useState(prefill?.entity_id || '');
  const [entityLabel, setEntityLabel] = useState(prefill?.entity_label || '');
  const [field, setField] = useState('daily_budget');
  const [oldValue, setOldValue] = useState('');
  const [newValue, setNewValue] = useState('');
  const [when, setWhen] = useState(todayLocal());
  const [exact, setExact] = useState(true);
  const [until, setUntil] = useState(todayLocal());
  const [reason, setReason] = useState('');
  const [outside, setOutside] = useState(false);
  const [outsideNote, setOutsideNote] = useState('');

  const [planReview, setPlanReview] = useState(true);
  const [hypothesis, setHypothesis] = useState('');
  const [observationDays, setObservationDays] = useState(7);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const meta = FIELDS.find((f) => f[0] === field);
  const numeric = !!meta?.[2];
  const canSave = entityId.trim() && field && reason.trim()
    && (!outside || outsideNote.trim())
    && (!planReview || hypothesis.trim());

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const from = new Date(when).toISOString();
      const to = exact ? from : new Date(until).toISOString();
      if (new Date(to) < new Date(from)) {
        throw new Error('The end of the interval is before its start.');
      }

      const id = await recordIntervention(shop.id, {
        entityType,
        entityId: entityId.trim(),
        entityLabel: entityLabel.trim() || null,
        field,
        oldValue: numeric && oldValue !== '' ? Number(oldValue) : null,
        newValue: numeric && newValue !== '' ? Number(newValue) : null,
        valueUnit: meta?.[2] || null,
        occurredFrom: from,
        occurredTo: to,
        // Always a manual report from this form. A detected change is written by
        // the sync, never by a person, and mislabelling one as the other is the
        // provenance error that makes hand-work look verified.
        confirmation: CONFIRMATION.MANUAL,
        reason: reason.trim(),
        recommendationId: prefill?.kind === 'recommendation' ? prefill.id : null,
        policyException: outside,
        policyNote: outside ? outsideNote.trim() : null,
      });

      if (planReview) {
        const due = new Date(to);
        due.setDate(due.getDate() + Number(observationDays || 7));
        const reviewId = await planOutcomeReview(shop.id, {
          interventionId: id,
          recommendationId: prefill?.kind === 'recommendation' ? prefill.id : null,
          hypothesis: hypothesis.trim(),
          targetMetric: 'total_shop_gmv',
          observationDays: Number(observationDays) || 7,
          plannedReviewAt: due.toISOString(),
        });

        // THE CHANGE HAS ALREADY BEEN MADE, SO THE REVIEW IS NOT "PLANNED".
        //
        // A review opens in `planned`, which is right when the criteria are
        // written before anyone touches the campaign. This form records
        // something that ALREADY HAPPENED, so the very next state is true the
        // moment it is saved. Leaving it at `planned` stranded the review: the
        // dialog offers no controls in that state, so nothing could ever reach
        // a review — caught by the end-to-end loop test, not by reading it.
        //
        // Moved through advance_outcome_review rather than inserted as
        // `applied` directly, so the transition is checked and lands in the
        // audit trail like every other one.
        await advanceReview(reviewId, 'applied',
          'recorded alongside a change that had already been made');
      }

      onSaved?.(id);
    } catch (e) {
      // Shown, never swallowed, and the form keeps everything the operator
      // typed so a failed save costs them nothing.
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open onClose={onClose}
      title="Record a change"
      sub="Something you already changed. This records it; it does not make it."
      footer={(
        <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
          <button className="btn btn-quiet" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={!canSave || busy}>
            {busy ? 'Saving…' : 'Record it'}
          </button>
        </div>
      )}
    >
      {error && <Notice tone="error">Could not save: {error}</Notice>}

      <div className="formgrid">
        <label className="field">
          <span>What kind of thing changed</span>
          <select className="input" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            {ENTITY_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>

        <label className="field">
          <span>Its ID</span>
          <input className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)}
            placeholder="1855416962446337" />
        </label>

        <label className="field">
          <span>Name <span className="muted">(optional)</span></span>
          <input className="input" value={entityLabel} onChange={(e) => setEntityLabel(e.target.value)}
            placeholder="Fruity Bites (All 4) GMV Max" />
        </label>

        <label className="field">
          <span>What you changed</span>
          <select className="input" value={field} onChange={(e) => setField(e.target.value)}>
            {FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>

        {numeric && (
          <>
            <label className="field">
              <span>From</span>
              <input className="input" type="number" step="any" value={oldValue}
                onChange={(e) => setOldValue(e.target.value)} placeholder="550" />
            </label>
            <label className="field">
              <span>To</span>
              <input className="input" type="number" step="any" value={newValue}
                onChange={(e) => setNewValue(e.target.value)} placeholder="660" />
            </label>
          </>
        )}

        <label className="field">
          <span>
            When
            <Hint text="If you know the moment, give it. If you only know it happened somewhere between two times, switch to an interval — a made-up timestamp is worse than an honest range, because everything downstream treats it as fact." />
          </span>
          <input className="input" type="datetime-local" value={when}
            onChange={(e) => setWhen(e.target.value)} />
        </label>

        <label className="field" style={{ alignSelf: 'end' }}>
          <span className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={!exact} onChange={(e) => setExact(!e.target.checked)} />
            <span>I only know a rough window</span>
          </span>
        </label>

        {!exact && (
          <label className="field">
            <span>…and no later than</span>
            <input className="input" type="datetime-local" value={until}
              onChange={(e) => setUntil(e.target.value)} />
          </label>
        )}

        <label className="field field-wide">
          <span>Why you changed it</span>
          <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Spend was hitting the cap every day by mid-afternoon." />
        </label>

        <label className="field field-wide">
          <span className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={outside} onChange={(e) => setOutside(e.target.checked)} />
            <span>
              The tool would not have recommended this
              <Hint text="Recorded truthfully and flagged. An action taken outside the guardrails still happened, and refusing to log it would only mean the outcome arrives unexplained. Evidence drawn from this episode carries the flag." />
            </span>
          </span>
        </label>

        {outside && (
          <label className="field field-wide">
            <span>What it did not support</span>
            <input className="input" value={outsideNote} onChange={(e) => setOutsideNote(e.target.value)}
              placeholder="Budget was not shown to bind, but I had campaign-level context the tool cannot see." />
          </label>
        )}
      </div>

      {/* THE CRITERIA ARE SET BEFORE THE RESULT IS KNOWN. That is the entire
          value of writing them here rather than at review time. */}
      <div className="panel" style={{ marginTop: 'var(--s4)', padding: 'var(--s4)' }}>
        <label className="row" style={{ gap: 8, marginBottom: 'var(--s3)' }}>
          <input type="checkbox" checked={planReview} onChange={(e) => setPlanReview(e.target.checked)} />
          <strong>
            Plan how you will judge this
            <Hint text="Written down now, before the result exists. Criteria set after seeing the outcome are how a tool comes to say it was right every time — so once a review is recorded these can no longer be changed at all, and until then only by an amendment with a reason." />
          </strong>
        </label>

        {planReview && (
          <div className="formgrid">
            <label className="field field-wide">
              <span>What you expect to happen</span>
              <input className="input" value={hypothesis} onChange={(e) => setHypothesis(e.target.value)}
                placeholder="Delivered spend rises and shop GMV rises with it, without ROI falling below 1.3." />
            </label>
            <label className="field">
              <span>Judge it after</span>
              <select className="input" value={observationDays}
                onChange={(e) => setObservationDays(e.target.value)}>
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={21}>21 days</option>
                <option value={28}>28 days</option>
              </select>
            </label>
          </div>
        )}
      </div>
    </Drawer>
  );
}
