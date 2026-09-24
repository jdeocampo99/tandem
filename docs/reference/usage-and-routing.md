# Usage and routing

How Tandem records what a request cost and took, and how it picks the exact model for an attempt.

Code: src/runtime/usage.ts, src/runtime/usage-events.ts, src/runtime/usage-ledger.ts,
src/runtime/usage-codec.ts, src/runtime/usage-receipt.ts, src/config/model-tier.ts,
src/workers/execution-routing.ts

## The accounting ledger

- Each durable request has one append-only ledger in the `request_usage_events` table of
  `<home>/state.sqlite`, joined to the request identity. It is the single owner of usage, cost,
  quota, and timing records for a request.
- It records facts and uncertainty only: nothing in it authorizes, pauses, retries, or blocks work.
  Unavailable telemetry never fails a receipt or a state transition.
- Events are `intake` (brief became durable; the clock starts), `work` (one settled operation; work in
  flight is never recorded), `provider-sample` (one provider call, as reported), and `terminal`
  (the delivery, cancellation, or failure that settled the request).
- Each event key derives from durable records, never observation time, so a replay after restart,
  reconciliation, or compaction counts once. A distinct attempt has a distinct operation or attempt
  identity.

## Timing

- Elapsed is wall time from intake to terminal, including all waits. Parallel work is merged into a
  union of intervals, overlap is reported separately, and waiting is elapsed minus active.
- Delivery ends at the verified-PR handoff: the terminal event is written when the ledger first sees
  the PR `open` (or already `merged`). Its key has no time, so a later merge cannot move it.
- A late cost receipt updates totals but is clamped out of timing.
- The first recorded delivery adds one coordinator notification with the receipt. An open request's
  receipt measures up to now, counting only finished work.

## Attribution

- Each worker's extension sums OMP's per-reply usage (tokens and price-table cost), plus each
  `task` call's aggregated subagent usage (`details.usage`), into `<job>.usage.json`; the settled work span carries `actual` tokens and an `estimated` charge from
  `omp-model-price-table`, a list price rather than a subscription bill.
- Research is credited through the implementation that cites it in `researchTaskIds`, without joining
  the request.
- Coordinator replies go to `<home>/coordinator-usage.jsonl`. The coordinator serves every request,
  so a receipt shows them as a separate shared line, never in the request total.
- An implementation task created without `requestId` joins the repository's one open request (approved
  brief, governed work not all finished). With none it stands alone; with several, create is refused.

## Provenance and privacy

- Every figure is `actual`, `estimated` (names method and source), or `unavailable` (closed set of
  reasons). Unavailable figures are excluded from totals, never counted as zero, and never support a
  claimed saving. A job with no token tally (model-free validation) reports `no-provider-boundary`.
- Included quota stays in provider units, never dollars. Charges are integer USD micro-dollars.
- Events hold only identities, enumerated statuses and reasons, timestamps, and counts. Labels are
  bounded and unknown fields are refused on write and read, so no prompt, payload, key, repository
  content, or full error reaches a receipt.
- A missing, stale, or malformed row is counted as unreadable and stays visible.

## Where routing decides

- The model is resolved only before a job launches and before a replacement attempt after a known safe
  failure. No per-turn optimization, mid-turn switching, or learning from outcomes.
- The worker concurrency limit refuses the reservation before routing runs; routing cannot widen it.
- The decision is an execution transition on the admitting durable operation, recording attempt
  identity, exact selector and thinking level, tier evidence and source, enabled providers, and the
  concurrency limit. Job construction and the execution gate both read the model from it.
- A non-pinned model runs only when a transition authorizes exactly it; an audit note admits nothing.
  A transition is fenced to its operation, job, generation, input HEAD, and policy digest; the gate
  refuses a stale one. Routing never writes to pinned policy.

## Tier evidence

- Evidence is the OMP catalogue, read fresh at the boundary. `cost` is descriptive, not this account's
  pricing. `includedAllowance` (`plan`, `unit`, `unitsPerRequest`) is quota with no currency.
- A candidate is comparable only when both figures are published for both models under the same plan
  and unit, and neither rises. A known rise on either axis is premium, even if prepaid or if money is
  equal. Unpublished allowance is unknown, not zero.
- A premium or unclear candidate is never taken. An unreadable or empty catalogue supplies no evidence;
  the pinned model continues and the transition records that no comparison was made.

## Automatic reassignment

- Only after a known safe failure of the pinned model, and only among providers the pinned profile
  enabled in `models.json`; catalogue discovery never authorizes a provider.
- Deterministic order: known included allowance, then lower published cost, then selector.
- An unproven prior outcome stays quarantined with its capacity and resources, never retried.
- `unaccountedSamples` or `unmeasuredTokenSamples` on the request mean unknown consumption, so the
  pinned model continues and the transition records the counts. No governing request (no ledger) also
  keeps the pinned model. The charged total is a floor, never used as a measurement.
- A replacement attempt never stops on a question: policy is fixed at creation, so the answer could
  only be "keep the pinned model".

## Routing pauses

Other questions stop the task on a durable `routingPause`. The coordinator is notified once and
nothing for the task starts while it stands. It stops standing when the pinned policy, generation, or
input HEAD moves.

| Reason | Meaning |
| --- | --- |
| `prior-outcome-uncertain` | Previous attempt unproven and quarantined. Also clears once it settles as a known failure. |
| `pinned-model-absent-from-catalogue` | On first launch the catalogue does not list the pinned model. |
| `pinned-model-ambiguous-in-catalogue` | The pinned selector matches several entries. |
| `pinned-model-thinking-level-unsupported` | The pinned model dropped the role's pinned thinking level. |

Pauses with a reason in `RETIRED_ROUTING_PAUSE_REASONS` (src/runtime/schema.ts) load but never stand.
