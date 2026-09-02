# Project Brief — AI Revenue Recovery Agent
### Razorpay AI Buildathon 2026 — Track 03: AI Revenue Recovery

---

## 0. One-line pitch

An agent that reads *why* a recurring payment failed, picks a bounded, explainable recovery action, executes it against Razorpay's test-mode APIs, and proves it worked with a measured recovery-rate report and a full audit trail — instead of the industry-standard blind "retry in 3 days" that every existing tool still ships.

---

## 1. How many people/merchants face this problem?

This is not a niche problem — it sits at the center of India's recurring-payments rail:

- NPCI reported **more than 850 million UPI AutoPay mandates registered cumulatively**, with **~95 million active mandates** processing roughly **4.2 crore (42 million) transactions every month** as of March 2026.
- **Over 20 million UPI AutoPay mandates are revoked or fail every single month**, largely due to insufficient balance at the moment of debit — spanning OTT, SIPs, loan EMIs, insurance premiums, and utility bills.
- Reported UPI Autopay failure/success rates vary noticeably by source — one industry piece puts UPI Autopay success at just **30–50%** (i.e. up to ~50–70% failure in the worst categories), while another estimates **8–15% failure** vs **2–3%** for card mandates. Both agree UPI Autopay fails meaningfully more than card e-mandates; the exact number depends heavily on merchant category and ticket size, so treat any single figure with caution.
- **~40% of all payment failures trace to downstream bank/infrastructure issues** (timeouts, throttling under UPI's ~21.6 billion monthly transaction load) — not something the merchant caused, but something a smarter retry *can* recover from.
- Globally, payment failures are estimated to cause **~34% of all involuntary SaaS churn**, and a **2% monthly payment-failure rate can erode ~22% of a subscription business's annual revenue**.
- Every merchant on Razorpay Subscriptions/Autopay, every SaaS/OTT/insurance/SIP business in India, is exposed to this by default — this is a rails-level problem, not a single-company problem.

**Caveat:** these are third-party/industry figures, not Razorpay's own internal numbers — cite them as "industry estimates," not ground truth, when presenting.

---

## 2. What problem are they actually facing?

**Merchants:**
- Revenue leaks silently. A customer who *intended* to keep paying churns "by accident" because a mandate bounced — not because they wanted to leave (involuntary churn, as distinct from voluntary churn).
- No visibility into *why* a payment failed, so merchants either (a) don't retry at all and write the revenue off, or (b) blindly retry everything on a fixed schedule, wasting attempts on failures that can never succeed on retry (e.g. an expired card) and annoying customers who already fixed the issue.
- Manual support/collections cost scales linearly with failure volume.

**Customers:**
- Get repeated debit notifications/attempts even when the actual fix needed (update card, add funds, re-authenticate) is completely different from "just try again."

**Compliance:**
- RBI's e-mandate framework imposes retry-window and authentication rules. Blind, unbounded retry logic risks non-compliance, not just a bad customer experience.

---

## 3. Existing solutions, their GitHub/community footprint, and disadvantages

| Solution | Type | Disadvantage |
|---|---|---|
| **Chargebee, Baremetrics Recover, Churn Buster, Recur, Churnkey, Redux** | Closed-source commercial dunning SaaS | Card/Stripe-centric, priced as an add-on, zero UPI Autopay or Indian e-mandate failure-code awareness. Baremetrics reports recovering **$1.35M in a single month across 148 businesses** — proof the category has real money in it, but none of it is India-rails-native. |
| **WooCommerce Subscriptions retry system** | Open source (WordPress plugin) | Purely **time-based**: fixed `retry_after_interval` rules regardless of *why* the payment failed. A companion plugin (`woocommerce-subscriptions-cancel-after-retry`) just counts attempts and cancels — no root-cause branching at all. |
| **Lago** (open-source billing) | Open source | More modern — configurable retry cadences, overdue-balance tracking, webhooks — but still **cadence-based, not cause-aware**. Doesn't branch strategy by decline reason. |
| **Polar** (open-source Stripe-alternative billing) | Open source | Has a real dunning state machine, but a **live GitHub issue (#10811)** shows their dunning-attempt counter conflates *customer-initiated manual retries* and *payment-method-update retries* with true automated dunning attempts — causing retries to exhaust prematurely or index out of bounds. This is concrete proof that even a funded, actively maintained open-source billing engine gets this state machine subtly wrong. |
| **GitHub's own billing / Expensify** | Production systems, not open source | Public GitHub Discussions (#139473, #30884) show the customer-facing failure mode of bad dunning: no manual "retry now" button, a blind 5-day wait even after the customer has already fixed the underlying issue. |

---

## 4. Related GitHub resources

- `github.com/woocommerce/woocommerce-subscriptions-cancel-after-retry`
- `gist.github.com/thenbrent/34656a3c97ed2003166b` — WooCommerce Subscriptions custom retry-rule example (shows the fixed-interval pattern to avoid)
- `github.com/polarsource/polar` — issue **#10811**, "Dunning attempts can be exhausted prematurely"
- `github.com/getlago/lago` — open-source billing with configurable dunning cadences
- `github.com/orgs/community/discussions/139473` and `.../30884` — GitHub's own billing retry pain, useful as user-research evidence
- Suggested further search terms for your own research pass: `"razorpay subscriptions webhook dunning"`, `"UPI autopay retry github"`, `"e-mandate NACH retry india"`

---

## 5. Existing Solutions & Gaps (summary)

1. **Reactive, not cause-aware** — nobody branches the actual recovery *strategy* by decline reason; at best they tune cadence.
2. **Card/Stripe-centric** — zero UPI Autopay / Indian e-mandate-specific logic, despite India being one of the largest real-time payments markets in the world with a distinct failure taxonomy (bank infra ~40%, insufficient-funds tied to salary cycles, AFA/auth friction).
3. **No compliance-grade audit trail** — none surface a decision-level log ("why this action, what evidence, what happened") suitable for RBI retry-limit compliance; they show recovery-rate dashboards, not decision reasoning.
4. **State-machine correctness is a genuinely open problem** — proven by the Polar bug — meaning a *correct* implementation is itself a differentiator, not a given.
5. **No per-customer timing intelligence** — every tool retries on a static day-N schedule; none infer an individual customer's pay cycle from their own payment history.

---

## 6. AI & Architecture Angle

Use the LLM only where the problem is genuinely unstructured — everything that moves money stays deterministic:

- **Classifier fallback**: rule-based lookup on failure code first; LLM call only when a free-text gateway/bank message doesn't map to a known code.
- **Nudge generation**: LLM drafts a personalized recovery message (e.g. Hinglish WhatsApp/SMS copy) tuned to the specific failure reason — this is where generative text genuinely beats a static template.
- **Everything else — strategy selection, retry scheduling, stopping rules, escalation — is a deterministic state machine.** This is a deliberate architecture choice: Razorpay's own track brief demands "every money action explainable, bounded and gated," and a panel at a payments company will read undisciplined LLM-driven money movement as a red flag, not a feature.

Pipeline: `failed payment webhook → classifier → strategy selector → executor (Razorpay test-mode API) → audit & reporting layer`, with the LLM sitting only inside the classifier's fallback path and the nudge-generation step.

---

## 7. What is our micro-innovation?

**Primary: salary-cycle-aware retry timing.**
Insufficient-funds failures (the single largest addressable bucket in India) cluster around common salary dates (1st, 7th, month-end for daily-wage earners). Instead of the industry-default static "retry T+3 days," the strategy selector infers each customer's likely pay cycle from the *timestamps of their own past successful debits* (not a demographic assumption) and schedules the retry against that inferred date. This is on the order of ~50 lines of logic, but it targets the exact failure bucket every cited source agrees is both the largest and the most recoverable-by-timing.

**Secondary: explicit manual-vs-system retry separation in the audit trail.**
Deliberately fixes the exact bug class that hit Polar in production (issue #10811) by tagging every retry event with its trigger source (`system_dunning` vs `customer_manual`) so the stopping-rule counter never conflates the two. This is a small design decision with an outsized credibility payoff: it shows you read and understood a real failure in a live billing engine, not just prompted an LLM for an architecture diagram.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| No access to real production failure data; synthetic data may not reflect the true distribution | Ground the synthetic generator in the cited real percentages (≈40% bank-side, insufficient-funds majority) instead of guessing |
| Scope creep — multi-channel nudges (WhatsApp + SMS + email) eat the week | Cut to one real channel (or one stubbed channel), protect time for the audit/stopping-rule logic, which is what's actually being judged |
| LLM misclassification could trigger a wrong action (e.g. blind retry on what was actually a risk_block) | Deterministic fallback: below a confidence threshold, default to the *safest* action (escalate to human), never default to retry |
| Compliance optics — this track is judged partly by a payments company's own risk lens | Treat stopping rules and the audit trail as a credibility requirement, not a nice-to-have; a design that could read as mandate-retry-spam is a bigger risk than a small feature gap |
| One-week timeline — polishing frontend at the expense of state-machine correctness | Prioritize backend logic and the batch-run metrics first; minimal frontend (a single dashboard page is enough) |

---

## 9. Small innovation, big advantage — standing out among ~499 other submissions

Most Track 03 entries will be a generic "AI chatbot that reminds customers to pay" — an LLM wrapper with no real measurement. Differentiate on:

1. **A named, cited root-cause taxonomy** grounded in real NPCI/Razorpay-adjacent failure data, not invented buckets.
2. **One concrete, defensible micro-innovation** (salary-cycle-aware retry) that is small in code but ties directly to the single largest empirically documented failure bucket — easy to explain in 30 seconds on camera.
3. **Demonstrated engineering literacy**: citing and explicitly designing around a real bug in a production open-source billing engine (Polar #10811) signals you studied prior art, which almost no other entrant will do.
4. **Hard numbers, not narrative** — your own batch run showing ₹ recovered / ₹ at risk / recovery-rate by root cause. Most 500 demo videos will show a UI and vibes; yours shows a number and a decision log.
5. **Deliberate failure injection + graceful fallback, shown on video** — directly targets the named "Failure Recovery" judging axis, which most entrants won't even realize is being scored separately.

---

## Sources consulted
- razorpay.com/blog/upi-autopay-vs-card-e-mandates
- razorpay.com/blog/payment-gateway-reliability-india-businesses-2026
- business.phonepe.com — Understanding UPI Autopay Mandates
- productgrowth.in/insights/fintech/upi-autopay-guide
- essara.space/tools/upi-autopay-tracker (NPCI March 2026 bulletin figures)
- business-standard.com — UPI AutoPay revocation reporting, Sept 2025
- chargebee.com/blog/dunning-management-for-saas-business
- baremetrics.com/blog/dunning-management
- beastinsights.com/blog/dunning-management
- github.com/polarsource/polar (issue #10811)
- github.com/woocommerce/woocommerce-subscriptions-cancel-after-retry
- getlago.com/blog/dunning-management
