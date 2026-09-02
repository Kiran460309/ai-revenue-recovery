# Security & Compliance Notes

- No real customer PII — synthetic data only.
- Stopping rules exist specifically to respect RBI e-mandate retry-window compliance, not just UX (see 01-project-brief.md §2, §8).
- risk_block classifications are never auto-actioned — escalation to a human is the only path, by design.
