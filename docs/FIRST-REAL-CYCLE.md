# The first real cycle — a runbook

Everything built so far has been exercised with synthetic data. That proves the
software works. It does not prove the advice is worth following, and nothing in
this repository can prove that. Only a real change on a real campaign, judged
against criteria written down beforehand, can.

This is that first cycle. It is written to be followed by the operator, not by
the tool, and it deliberately does not choose the change for you.

---

## Before you start

**Pick the campaign yourself.** On Biostime the only live one is *Fruity Bites
(All 4) GMV Max* — the other three are paused, so a change to them would test
nothing.

**Expect the tool to refuse to size the step.** No Target ROI change has ever
been observed on this shop, so there is nothing to learn a step size from. It
will say so and ask you to choose. That is the honest state, not a fault, and
choosing it yourself is what creates the first episode.

**Do not run two changes at once.** A budget change and a Target ROI change in
the same week produce an episode that can never be attributed to either, and the
eligibility rules will correctly exclude it. One change, then wait.

---

## 1. Read what the tool currently says

Open **Overview** for the shop and read the priority strip.

Check its guardrails before anything else. If "revenue reconciles" or "every day
of the report arrived" is failing, the evidence underneath is incomplete and the
first cycle should wait for a clean window.

## 2. Choose the change

Open **Campaigns → the campaign → Target ROI**.

Both directions are shown. Today both say *no history to reason from*. Decide
which question you actually want answered:

- **Lower Target ROI** if delivery is short of the budget and you want more of it
- **Raise Target ROI** if delivery is fine and you want efficiency

Pick a step you would be comfortable reverting. A first episode exists to create
evidence, not to win.

## 3. Write down how you will judge it — BEFORE making the change

Click **Plan a test yourself**. Fill in:

- **What you expect to happen.** A sentence, in your own words. "Delivered spend
  rises toward the cap and shop GMV rises with it, without ROI falling below 1.3."
- **Judge it after.** 7 days is the default. 14 if the campaign is low-volume.

These criteria freeze. You can amend them with a reason until the review is
recorded, and not at all afterwards. That restriction is the point: criteria
chosen after seeing the result are chosen to fit it.

## 4. Make the change in TikTok Ads Manager

The tool does not do this and will not. Open Ads Manager and change the setting.

## 5. Record what you actually did

Back in **Decision log → Record a change**:

- The campaign id and the field you changed
- **From** and **to** — the real values
- **When** — if you know the moment, give it. If you only know it was some time
  this afternoon, tick *"I only know a rough window"* and give the range. Do not
  round to a clean time; a made-up timestamp is treated as fact by everything
  downstream.
- **Why** — one sentence. This is what you will read in three weeks.

If you made a change the tool would not have recommended, tick that box. It is
recorded and flagged, not blocked. An action taken outside the guardrails still
happened, and losing the record only means the outcome arrives unexplained.

## 6. Wait

The review appears in the Decision log with its date. Two things can happen:

- **Review due** — the window has passed and the data has settled. Go to step 7.
- **Waiting for data** — the window has passed but a source is short of days.
  This is correct. A result computed on half-arrived orders looks like a result,
  which is worse than not having one. Wait.

## 7. Review it honestly

Open the entry and answer three separate questions:

**Did the metric move?** Favourable, unfavourable, mixed — or **not measurable**.
Use "not measurable" if the change was never actually made, the campaign was
paused, or coverage was too thin. That is not a failure, and recording it as one
would poison every later comparison.

**What does that establish?** Almost certainly **Observed** — the number before
and the number after. That is honest and it is enough. It is not proof the change
caused it, and the tool will not describe it as such.

**What will you do?** Keep it, revert it, run it longer, stop, or inconclusive.
If you revert, that is a decision — record the reversal as its own change when
you make it.

Add a note about anything else that was going on. If there was a promotion or a
stockout, record it as a context event; the review will attach it and any future
recommendation will know that episode was confounded.

---

## What you will have afterwards

One reviewed episode. Not a response function — the tool will say so, in those
words, and will not offer a candidate setting from a single case.

But the next recommendation for that action will carry **"What happened last
time"**, and if this one went badly it will say so and ask for a smaller step.
That is the loop closing for the first time.

Three or four clean episodes in the same direction is roughly where Target ROI
headroom starts proposing a candidate — always inside the range the campaign has
actually run at, never extrapolated past it.

---

## If something looks wrong

**The tool recommends "fix your data" above everything else.** Two sources
disagree by more than 3%. Open Data status; the disagreement is listed by day.

**A recommendation you accepted has vanished from the queue.** It has not. The
Decision log holds everything including rejections and deferrals. Filter by state.

**A figure changed after you recorded the intervention.** Late settlement. The
original evidence is frozen on the recommendation and the restatement is recorded
separately — open the entry and both are shown. Nothing is being hidden and
nothing was overwritten.
