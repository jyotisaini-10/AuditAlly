# AuditAlly — Architecture Decisions

## Why axe-core instead of LLM-only detection?

**axe-core is deterministic.** It applies the same WCAG 2.A/AA rule evaluation on every run: the same page always produces the same set of violations, with no hallucination risk. LLMs are not reliable accessibility detectors — they lack the structural page context (DOM tree, computed styles, ARIA relationships) that axe-core operates on natively.

The design principle is: **deterministic tools do detection, the LLM does interpretation.** axe-core identifies *what* is wrong with certainty; the LLM explains *why it matters* and *how to fix it* in plain language.

This means:
- Zero false negatives due to LLM forgetting a rule
- Zero hallucinated violations
- Reproducible, auditable results
- LLM cost is only incurred for the interpretation layer

---

## Why an async job queue (BullMQ)?

A Puppeteer + axe-core scan takes 5–30 seconds per URL (network load time, JS render, audit). A synchronous HTTP approach would:
- Time out in browser contexts (30s max)
- Block the Node.js event loop for all other requests
- Give zero feedback to the user during the wait

BullMQ with Redis solves all three:
1. `POST /scan` returns a `jobId` in milliseconds
2. The heavy work runs in a background worker (separate event loop context)
3. The frontend subscribes to `GET /scan/:id/stream` (Server-Sent Events) and receives per-violation progress as explanations complete — no polling needed

This also makes the system naturally backpressure-aware: if the queue fills up, new jobs wait rather than overwhelming the server.

---

## Why the caching strategy works the way it does

Two independent caching layers:

### 1. URL-level scan cache (Redis, default TTL 1 hour)

When a user submits a URL that was scanned within the TTL window, we return the cached axe+LLM result instantly:
- No Puppeteer launch (saves ~5–30s)
- No Groq API call (saves cost + latency)
- The user sees `cached: true` with the age of the result

This is appropriate because most public pages don't change within an hour. The cache is bypassed if `force: true` is passed in the request.

### 2. Violation explanation cache (Redis, default TTL 7 days)

Even when a fresh scan runs on a new URL, individual violations are often identical across different sites (e.g., the exact same `<img>` missing alt text). We fingerprint each violation by `ruleId + CSS selector + HTML snippet` and cache the LLM explanation.

This means: a site that shares 10 violations with a previously-scanned site only pays for the LLM to explain the *new* violations. The `llmReusedCount` field in the response shows how many were served from cache.

---

## Why Groq was chosen

**Latency and cost:**
- Groq's LPU inference hardware delivers ~500 tokens/second for Llama 3.3 70B — roughly 5–10× faster than OpenAI GPT-4o
- Price: ~$0.59/$0.79 per million input/output tokens (vs. ~$15/$60 for GPT-4o)
- With per-violation prompts averaging ~400 input / ~200 output tokens, explaining 10 violations costs roughly **$0.004** — essentially free

**OpenAI-compatible API:**
- Uses the standard `openai` npm package pointed at Groq's base URL
- Easy to swap to another provider (OpenAI, Anthropic) by changing `GROQ_API_KEY` and the base URL

**JSON mode:**
- Groq supports `response_format: { type: "json_object" }` natively
- Combined with a structured system prompt, this virtually eliminates malformed responses
- The codebase still validates/retries/falls back gracefully for the rare case where parsing fails

---

## Security decisions

### SSRF protection

The scan endpoint accepts arbitrary user-submitted URLs and triggers server-side HTTP requests (via Puppeteer). Without protection, an attacker could scan `http://169.254.169.254/` (AWS metadata endpoint) or `http://localhost:6379` (Redis).

`urlSafety.ts` implements:
1. Hostname blocklist (localhost, 0.0.0.0, ::1)
2. Private IP range regex check before DNS resolution
3. DNS resolution of the target hostname + IP validation of all returned addresses

### Rate limiting

Redis-backed sliding-window counter per user (if authenticated) or IP (if anonymous). Configurable max scans per window. Fails open (allows requests) if Redis is unavailable.

### JWT auth

Stateless JWTs with 30-day expiry. Passwords hashed with bcrypt (12 rounds). Auth is optional for scanning — anonymous scans work but results aren't saved to history.

---

## Data model

Each scan stored in MongoDB contains:
- Raw axe-core violations (rule ID, WCAG tags, CSS selector, offending HTML, failure summary)
- LLM explanations per violation (plain language, why it matters, suggested fix, severity, confidence)
- Computed accessibility score (0–100, weighted by severity)
- Regression diff vs previous scan of same URL (fixed/new/unchanged counts)
- LLM usage stats (tokens, estimated cost, reused count)
- Optional share token for public HTML report

Indexes: `(userId, scannedAt)`, `(userId, url, scannedAt)`, `shareToken (sparse)`
