# System Architecture

Pipeline: failed payment event → Classifier → Strategy selector → Executor (Razorpay test-mode API) → Audit & reporting layer.

- Classifier: rule table on failure_code first; LLM call only as fallback for free-text gateway messages.
- Strategy selector: deterministic state machine, encodes the intervention map + stopping rules explicitly (not scattered if/else).
- Executor: makes real Razorpay test-mode calls for retries; nudge channel can be stubbed (log what would have been sent).
- Audit layer: every stage writes {timestamp, event_id, root_cause, confidence, action_taken, trigger_source, result} — this is the single source of truth for the recovery-rate dashboard and for compliance review.

See the conversation-level diagram (recovery_agent_pipeline) for the visual version of this flow.
