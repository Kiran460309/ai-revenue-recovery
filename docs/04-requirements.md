# Requirements

## Functional
1. Ingest a batch of failed-payment events (synthetic, modeled on real Razorpay/NPCI failure-code distributions — see 01-project-brief.md §1).
2. Classify each event into: insufficient_funds, expired_instrument, bank_timeout, risk_block, unknown.
3. Select an intervention per root cause (see architecture doc for the mapping table).
4. Execute via Razorpay test-mode API; log every call.
5. Enforce stopping rules: max 3 attempts, cooldown windows, hard stop after 2 consecutive risk_blocks.
6. Tag every retry event with trigger source (system_dunning vs customer_manual) — see 01-project-brief.md §7 (fixes the Polar #10811 bug class).
7. Report recovery rate by root cause + false-stop rate.

## Non-functional
- Every money-moving decision must be explainable from the audit log alone.
- LLM used only for: (a) classifying unstructured gateway text, (b) generating nudge copy — never for choosing whether/how much to retry.
