Tech Stack
Optimized for one person, ~6-7 days, and a 5-minute demo video — not for production scale. Every choice below trades "impressive-sounding" for "actually finishes."
Recommended stack
Layer	Choice	Why
Backend	Python + FastAPI	Fastest path to a clean, typed API; native async; auto-generates OpenAPI docs for free (useful for docs/08-api-documentation.md); huge ecosystem for the classifier logic.
Payments	Razorpay Python SDK (`razorpay` on PyPI) + test-mode keys	Direct, official, well-documented. Use Orders/Payments/Subscriptions test-mode endpoints for the executor stage.
Database	SQLite via SQLAlchemy	Zero setup, file-based, fine for a synthetic batch of a few hundred rows. Upgrade path to Postgres is a one-line connection-string change if you want to look more "production-ready" — don't bother unless you have spare time.
Classifier (rule path)	Plain Python dict/lookup on `failure_code`	This is the majority path — deterministic, instant, free. No AI needed here and you shouldn't pretend otherwise.
Classifier (LLM fallback)	Claude API (Sonnet) or OpenAI, called only when the failure code doesn't map to a known bucket	Small number of calls, cheap, and this is the correct place to use an LLM — see docs/06-system-architecture.md.
Strategy selector	Plain Python state machine (a small class, not a framework)	The stopping-rule logic is exactly where bugs hide (see the Polar issue in 01-project-brief.md) — keep it simple enough to unit-test exhaustively rather than reaching for a workflow engine you won't have time to debug.
Scheduling (retries)	APScheduler (in-process)	No need for Celery/Redis/queues at this scale — one extra moving part you'd have to explain and defend to a panel for zero benefit.
Nudge channel	Stub it — log what would have been sent (or a single real channel: SendGrid for email is the fastest to actually wire up)	Multi-channel is scope creep per docs/04-requirements.md; one real or stubbed channel is enough to demo the concept.
Audit log	A table in the same SQLite DB (see docs/07-database-design.md), not a separate logging service	Keep infra minimal; the audit trail is a data model, not a tool choice.
Frontend / dashboard	Streamlit	Given the time budget, this is the highest-leverage choice: a working ₹-recovered-vs-at-risk dashboard with tables and a chart in under an hour, reading straight from the SQLite DB. If you have design/frontend skill and spare time, React + Vite + Tailwind + Recharts looks more polished for the video — only do this if the backend is already solid; a pretty dashboard on a broken pipeline loses to an ugly dashboard on a correct one.
Testing	pytest	Unit-test the classifier and the stopping-rule state machine specifically — that's what docs/11-testing.md calls out as the highest-risk area.
Environment/secrets	`.env` + `python-dotenv`	Razorpay test keys and LLM API key never committed — matches docs/09-authentication.md.
Repo/demo	GitHub public repo + a locally-runnable `README` setup (no need to deploy live)	Judges run/watch the video, not a live URL — don't burn time on hosting unless you finish everything else early.
Minimal dependency list
```
fastapi
uvicorn
sqlalchemy
razorpay
apscheduler
anthropic  # or openai
streamlit
pytest
python-dotenv
```
What to deliberately skip (and why)
No Docker/Kubernetes — nothing here needs container orchestration; it signals over-engineering for a synthetic-batch demo, not maturity.
No microservices — one FastAPI service with clear internal modules (`classifier.py`, `strategy.py`, `executor.py`, `audit.py`) reads better in a code review than four services with network calls between them.
No vector DB / RAG — there's no unstructured knowledge base to retrieve from here; a RAG pipeline would be AI-for-AI's-sake and actively hurts your "AI Judgment" score.
No Celery/Redis/message queue — APScheduler in-process is enough at this volume; introducing a queue you can't fully explain on camera is a liability, not a flex.
Day-by-day mapping to the stack
Day 1: FastAPI skeleton + SQLite models + Razorpay test-mode keys wired up.
Day 2: `classifier.py` — rule table first, Claude API fallback second.
Day 3: `strategy.py` — state machine + stopping rules, unit-tested.
Day 4: `executor.py` — real Razorpay test-mode calls + audit writes.
Day 5: Streamlit dashboard reading from the DB; run the full batch.
Day 6: Failure injection test + graceful fallback, written up in the README.
Day 7: Polish, record the pitch video, push to GitHub.