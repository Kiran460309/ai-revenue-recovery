# API Documentation (internal)

- POST /events/failed-payment — ingest a failed payment event
- GET /payments/{id}/classification — root cause + confidence
- GET /payments/{id}/audit-trail — full decision log for one payment
- GET /report/recovery-rate — ₹ recovered / ₹ at risk, by root cause

External: Razorpay Orders/Payments/Subscriptions test-mode APIs (see Razorpay API docs).
