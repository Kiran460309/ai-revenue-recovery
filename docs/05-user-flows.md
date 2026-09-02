# User Flows

## Flow 1 — Automated recovery (happy path)
Failed payment webhook → classifier assigns root cause → strategy selector picks intervention → executor calls Razorpay test-mode API → outcome logged → dashboard updates.

## Flow 2 — Stopping rule triggered
Third consecutive failure on same mandate → executor checks stopping rule → halts further auto-retry → logs reason → flags for manual review (no auto action on risk_block, per compliance requirement).

## Flow 3 — Deliberate failure injection (for the demo)
Simulated Razorpay API timeout mid-retry → executor catches the failure → logs it → falls back to the next safest action → shown explicitly in the pitch video (targets the "Failure Recovery" judging axis).
