# User Stories

- As a merchant, I want failed payments auto-classified by root cause, so I stop wasting retries on failures that can never succeed (e.g. expired card).
- As a merchant, I want a retry scheduled against my customer's likely pay cycle for insufficient-funds failures, so recovery rate improves without extra manual work.
- As a compliance reviewer, I want every retry/escalation decision logged with its trigger source and reasoning, so I can audit against RBI e-mandate retry rules.
- As a customer, I want to be notified with the *actual* fix needed (update card vs. wait vs. nothing to do), not a generic "payment failed" message.
- As a judge/reviewer, I want to see measured ₹ recovered vs ₹ at risk on a batch, not a narrative claim.
