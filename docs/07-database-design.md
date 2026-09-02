# Database Design (minimal, for the batch run)

## failed_payments
payment_id, customer_id, amount, failure_code, gateway_message, attempt_number, timestamp

## classifications
payment_id, root_cause, confidence, method (rule | llm_fallback)

## actions
payment_id, action_type, trigger_source (system_dunning | customer_manual), scheduled_for, executed_at, result

## audit_log
event_id, payment_id, stage, decision, reasoning, timestamp
