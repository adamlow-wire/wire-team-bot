# Wire Team Bot — synthetic quality evidence for human review

This renders [the final candidate report](step2-final-capture-report.json) for human inspection. It is evidence, not a separate delivery plan. Acceptance criteria and the live Wire cases remain in [PLAN.md](../../PLAN.md#final-manual-qa-on-the-pinned-staging-candidate).

**Review status: pending.** Automated matches do not constitute human approval. Runtime: `ae618ff`. The fixture uses synthetic Alice/Bob/Carol/Dave identities; legacy mention aliases below preserve the actual test inputs.

## Twenty source events and stored records

Records were inspected after processing exited. Generated record IDs are not match keys. Ten decisions and ten actions matched; zero duplicate/extra captures or privacy-marker occurrences. Inspect the meaning and ownership, not just the automated total.

### Source d1

Input: decision: use Postgres for the ledger because transactions are required

Expected: decision; terms: Postgres, ledger

Stored: use Postgres for the ledger because transactions are required

Source: `d1`; recorder: Alice; status: active.

Feedback: Text confirmation; reactions: none.

### Source a1

Input: action: write the ledger migration for Bob

Expected: action; terms: ledger, migration; owner: bob

Stored: write the ledger migration

Source: `a1`; owner: Bob; status: open.

Feedback: Text confirmation; reactions: none.

### Source d2

Input: decision: use REST for the billing API

Expected: decision; terms: REST, billing

Stored: use REST for the billing API

Source: `d2`; recorder: Alice; status: active.

Feedback: Text confirmation; reactions: none.

### Source a2

Input: Carol: action: review the billing API contract

Expected: action; terms: billing, contract; owner: carol

Stored: review the billing API contract

Source: `a2`; owner: Carol; status: open.

Feedback: Text confirmation; reactions: none.

### Source d3

Input: decision: deploy the dashboard in the London region

Expected: decision; terms: dashboard, London

Stored: deploy the dashboard in the London region

Source: `d3`; recorder: Alice; status: active.

Feedback: Text confirmation; reactions: none.

### Source a3

Input: action: prepare the dashboard rollout for Dave

Expected: action; terms: dashboard, rollout; owner: dave

Stored: prepare the dashboard rollout

Source: `a3`; owner: Dave; status: open.

Feedback: Text confirmation; reactions: none.

### Source d4

Input: decision: retain backups for thirty days

Expected: decision; terms: backup

Stored: retain backups for thirty days

Source: `d4`; recorder: Alice; status: active.

Feedback: Text confirmation; reactions: none.

### Source a4

Input: Bob: action: test the backup restoration

Expected: action; terms: backup, restor; owner: bob

Stored: test the backup restoration

Source: `a4`; owner: Bob; status: open.

Feedback: Text confirmation; reactions: none.

### Source d5

Input: decision: release the mobile app behind a feature flag

Expected: decision; terms: mobile, feature flag

Stored: release the mobile app behind a feature flag

Source: `d5`; recorder: Alice; status: active.

Feedback: Text confirmation; reactions: none.

### Source a5

Input: action: document the mobile release process for Carol

Expected: action; terms: mobile, release; owner: carol

Stored: document the mobile release process

Source: `a5`; owner: Carol; status: open.

Feedback: Text confirmation; reactions: none.

### Source d6

Input: We have agreed to use Redis for the session cache.

Expected: decision; terms: Redis, session

Stored: Adopt Redis as the session cache technology

Source: `d6`; recorder: Alice; status: active.

Feedback: No text confirmation; reactions: none.

### Source a6

Input: Bob: I will configure the session cache monitoring.

Expected: action; terms: session, monitor; owner: bob

Stored: Configure monitoring for the session cache

Source: `a6`; owner: Bob; status: open.

Feedback: No text confirmation; reactions: 📝.

### Source d7

Input: We decided that all invoice exports will be CSV files.

Expected: decision; terms: invoice, CSV

Stored: All invoice exports will be produced as CSV files.

Source: `d7`; recorder: Alice; status: active.

Feedback: No text confirmation; reactions: none.

### Source a7

Input: Carol: I will write the invoice export guide.

Expected: action; terms: invoice, guide; owner: carol

Stored: Write the invoice export guide

Source: `a7`; owner: Carol; status: open.

Feedback: No text confirmation; reactions: 📝.

### Source d8

Input: The team has decided to use Grafana for service dashboards.

Expected: decision; terms: Grafana, dashboard

Stored: Grafana will be used for service dashboards.

Source: `d8`; recorder: Alice; status: active.

Feedback: No text confirmation; reactions: none.

### Source a8

Input: Dave: I will build the service health dashboard.

Expected: action; terms: service, dashboard; owner: dave

Stored: Build the service health dashboard

Source: `a8`; owner: Dave; status: open.

Feedback: No text confirmation; reactions: 📝.

### Source d9

Input: We agreed that the support rota will rotate weekly.

Expected: decision; terms: support, weekly

Stored: The support rota will rotate on a weekly basis.

Source: `d9`; recorder: Alice; status: active.

Feedback: No text confirmation; reactions: none.

### Source a9

Input: Alice: I will publish the support rota.

Expected: action; terms: support, rota; owner: alice

Stored: Publish the support rota

Source: `a9`; owner: Alice; status: open.

Feedback: No text confirmation; reactions: 📝.

### Source d10

Input: We have decided to require two reviewers for security changes.

Expected: decision; terms: review, security

Stored: Security-related changes must be approved by two reviewers.

Source: `d10`; recorder: Alice; status: active.

Feedback: No text confirmation; reactions: none.

### Source a10

Input: Bob: I will update the security review checklist.

Expected: action; terms: security, checklist; owner: bob

Stored: Update the security review checklist

Source: `a10`; owner: Bob; status: open.

Feedback: No text confirmation; reactions: 📝.

## Ten known answers and one unknown-answer control

Check factual correctness, ownership, unsupported claims and usefulness. Human approval requires at least 8/10 useful known answers; the unknown answer must not invent facts or writes.

### q1

Question: @Jeeves Which database did we choose for the ledger and why?

Elapsed including processing: 7698 ms.

> Postgres, because transactions are required.
> 
> • **[DEC-0469] use Postgres for the ledger because transactions are required**
>   **Recorded by:** @Alice | **Date:** 2026-09-18
> 
> The decision makers aren't recorded on that entry — only that you logged it.
> 
> Related open action: **[ACT-0574] write the ledger migration** — **Owner:** @Bob | **Status:** open

### q2

Question: @Jeeves Who owns the ledger migration?

Elapsed including processing: 7796 ms.

> @Bob owns it.
> 
> • **[ACT-0574] write the ledger migration**
>   **Owner:** @Bob | **Status:** open
> 
> No deadline is stored against it. To add one: `ACT-0574 due <date>`. To hand it to someone else: `ACT-0574 reassign to <name>`.

### q3

Question: @Jeeves What interface did we choose for the billing API?

Elapsed including processing: 7613 ms.

> REST.
> 
> • **[DEC-0470] use REST for the billing API**
>   **Recorded by:** @Alice | **Date:** 2026-09-18
> 
> No rationale is stored against that entry, and the decision makers aren't recorded — only that you logged it.
> 
> Related open action: **[ACT-0575] review the billing API contract** — **Owner:** @Carol | **Status:** open

### q4

Question: @Jeeves Where are we deploying the dashboard?

Elapsed including processing: 8131 ms.

> The London region.
> 
> • **[DEC-0471] deploy the dashboard in the London region**
>   **Recorded by:** @Alice | **Date:** 2026-09-18
> 
> No rationale is stored against that entry, and the decision makers aren't recorded — only that you logged it.
> 
> Related open action: **[ACT-0576] prepare the dashboard rollout** — **Owner:** @Dave | **Status:** open

### q5

Question: @Jeeves How long do we keep backups?

Elapsed including processing: 6967 ms.

> Thirty days.
> 
> • **[DEC-0472] retain backups for thirty days**
>   **Recorded by:** @Alice | **Date:** 2026-09-18
> 
> No rationale is stored against that entry, and the decision makers aren't recorded — only that you logged it.
> 
> Related open action: **[ACT-0577] test the backup restoration** — **Owner:** @Bob | **Status:** open

### q6

Question: @Jeeves How are we releasing the mobile app?

Elapsed including processing: 8600 ms.

> Behind a feature flag.
> 
> • **[DEC-0473] release the mobile app behind a feature flag**
>   **Recorded by:** @Alice | **Date:** 2026-09-18
> 
> No rationale is stored against that entry, and the decision makers aren't recorded — only that you logged it.
> 
> Related open action: **[ACT-0578] document the mobile release process** — **Owner:** @Carol | **Status:** open

### q7

Question: @Jeeves What did we choose for the session cache?

Elapsed including processing: 7803 ms.

> Redis.
> 
> • **[DEC-0475] Adopt Redis as the session cache technology**
>   **Recorded by:** @Alice | **Date:** 2026-09-18
>   **Decided by:** @Alice
>   *Tags: infrastructure, caching*
> 
> No rationale is stored against that entry.
> 
> Related open action: **[ACT-0579] Configure monitoring for the session cache** — **Owner:** @Bob | **Status:** open

### q8

Question: @Jeeves What format are invoice exports?

Elapsed including processing: 16084 ms.

> CSV.
> 
> • **[DEC-0480] All invoice exports will be produced as CSV files.**
>   **Recorded by:** @Alice | **Date:** 2026-09-18
>   **Decided by:** @Alice
>   *Tags: invoicing, data-format, exports*
> 
> No rationale is stored against that entry.
> 
> Related open action: **[ACT-0580] Write the invoice export guide** — **Owner:** @Carol | **Status:** open

### q9

Question: @Jeeves Who will publish the support rota?

Elapsed including processing: 6641 ms.

> You will — it's assigned to you.
> 
> • **[ACT-0582] Publish the support rota**
>   **Owner:** @Alice | **Status:** open
>   *Tags: support, rota*
> 
> No deadline is stored against it. To reassign, use `ACT-0582 reassign to <name>`; to add a deadline, `ACT-0582 due <date>`.

### q10

Question: @Jeeves How many reviewers do security changes require?

Elapsed including processing: 7183 ms.

> Two.
> 
> • **[DEC-0486] Security-related changes must be approved by two reviewers.**
>   **Recorded by:** @Alice | **Date:** 2026-09-18
>   **Decided by:** @Alice
>   *Tags: security, code-review, policy*
> 
> No rationale is stored against that entry.
> 
> Related open action: **[ACT-0583] Update the security review checklist** — **Owner:** @Bob | **Status:** open

### unknown

Question: @Jeeves What is the approved budget for the Mars office?

Elapsed including processing: 7608 ms.

> I'm afraid I have no record of that particular matter. Nothing has been logged in this channel about a Mars office or any budget approval.
> 
> If a budget has been agreed elsewhere, you can record it with `decision: <the approved budget for the Mars office>`.

## Human review record

Reviewer/date: pending. Capture corrections or misses: pending. Useful known answers out of ten: pending. Latency/noise acceptable: pending. Record the final acceptance decision in PLAN.md; do not turn automated matches into a human sign-off.
