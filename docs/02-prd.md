# PRD — AI Revenue Recovery Agent

## Goal
Recover failed recurring/subscription payments by diagnosing root cause and executing a bounded, auditable intervention — measured on a synthetic batch of failed Razorpay test-mode transactions.

## In scope (MVP for the buildathon)
- Root-cause classifier (rule-based + LLM fallback)
- Strategy selector with hard-coded intervention map + stopping rules
- Executor calling Razorpay test-mode APIs
- Audit log + recovery-rate dashboard
- One deliberate failure injection + graceful fallback, documented

## Out of scope (for v1)
- Multi-channel nudges beyond one channel
- Real production data / real customers
- Human-in-the-loop UI for risk_block escalation (stub is enough)

## Success metric
₹ recovered / ₹ at risk on the batch, broken down by root-cause bucket, plus an honest false-stop rate.

See `01-project-brief.md` for the full problem research and differentiation strategy.
