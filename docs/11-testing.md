# Testing

- Unit tests on the classifier (known failure codes → expected root cause).
- Unit tests on the strategy selector's stopping-rule logic (this is where the Polar-style bug would hide — test the manual-vs-system retry counting explicitly).
- One deliberate integration-level failure injection (simulated API timeout) with an assertion that the executor falls back gracefully instead of crashing or silently double-charging.
