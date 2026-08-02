# AuditAlly — AI-Powered Accessibility Auditor

**AuditAlly** scans any public URL for WCAG 2.A/AA violations using [axe-core](https://github.com/dequelabs/axe-core), then uses an LLM (Groq / Llama) to translate raw violations into plain-language explanations and concrete code fixes.

> **Design principle:** Deterministic tools do detection, the LLM does interpretation.

---

## Architecture

```
Browser Client
     │
     ▼
┌─────────────────┐
│  React Frontend │  (Vite + Tailwind CSS v4)
│  SPA @ :8080    │
└────────┬────────┘
         │ /api proxy → :3000
         ▼
┌─────────────────────────────────────────────┐
│           Express API  (:3000)              │
│                                             │
│  POST /scan   ──► Redis URL cache check     │
│                    │ miss                   │
│                    ▼                        │
│             BullMQ job queue                │
│                    │                        │
│                    ▼                        │
│        ┌──────────────────────┐             │
│        │   Scan Worker        │             │
│        │  Puppeteer + axe-core│             │
│        │  → Groq LLM explain  │             │
│        │  → MongoDB persist   │             │
│        └──────────────────────┘             │
│                                             │
│  GET /scan/:id/stream  (SSE)                │
│  GET /scans            (history)            │
│  GET /reports/:token   (public HTML report) │
└─────────────────────────────────────────────┘
         │                │
         ▼                ▼
    MongoDB :27017   Redis :6379
    (scan history)   (queue + cache)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript + Tailwind CSS v4 |
| Backend | Node.js + Express + TypeScript |
| Browser automation | Puppeteer + axe-core |
| Job queue | BullMQ + Redis |
| Database | MongoDB (via Mongoose) |
| Caching | Redis (scan cache + explanation dedup) |
| LLM | Groq API (Llama 3.3 70B) via OpenAI-compatible SDK |
| Auth | JWT (email/password) |
| Container | Docker + docker-compose |

---

## Quick Start (Docker)

### Prerequisites
- Docker + Docker Compose
- A Groq API key (free at [console.groq.com](https://console.groq.com)) — or use mock mode without one

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env:
#   GROQ_API_KEY=your-key-here     # or leave blank and set AUDITALLY_LLM_MOCK=1
#   JWT_SECRET=a-long-random-string
```

### 2. Run everything

```bash
docker compose up --build
```

- **Frontend:** http://localhost:8080
- **API:** http://localhost:3000
- **Health check:** http://localhost:3000/health

### Mock mode (no API key needed)

Set `AUDITALLY_LLM_MOCK=1` in `.env` — the system will produce deterministic mock explanations for all violations, useful for local development and testing.

---

## Local Development (without Docker)

### Prerequisites
- Node.js 20+
- MongoDB (local or Atlas)
- Redis

```bash
# Backend
npm install
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Frontend dev server at http://localhost:5173 (proxies `/api` → `:3000`).

---

## Running Tests

```bash
npm test
```

Tests cover:
- LLM prompt construction
- JSON response parsing + validation
- Graceful fallback when LLM fails
- Violation fingerprinting
- Regression diff (fixed/new/unchanged)
- Accessibility score computation

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | API server port |
| `MONGODB_URI` | `mongodb://localhost:27017/auditally` | MongoDB connection |
| `REDIS_URI` | `redis://localhost:6379/2` | Redis connection |
| `JWT_SECRET` | *(required)* | JWT signing secret |
| `GROQ_API_KEY` | *(required for real LLM)* | Groq API key |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model |
| `AUDITALLY_LLM_MOCK` | `0` | Set `1` for mock explanations |
| `SCAN_CACHE_TTL_SECONDS` | `3600` | How long to cache scan results |
| `SCAN_CACHE_DISABLED` | `0` | Set `1` to disable caching |
| `EXPLAIN_CACHE_TTL_SECONDS` | `604800` | LLM explanation cache TTL (7 days) |
| `RATE_LIMIT_MAX_SCANS` | `20` | Max scans per IP/user per window |
| `RATE_LIMIT_WINDOW_SECONDS` | `3600` | Rate limit window |
| `GROQ_INPUT_COST_PER_1M` | `0.59` | Input token cost for display |
| `GROQ_OUTPUT_COST_PER_1M` | `0.79` | Output token cost for display |
| `PUBLIC_URL` | `http://localhost:8080` | Base URL for shareable report links |

---

## Puppeteer / Chrome in Docker

The backend Dockerfile installs system Chromium (`apt-get install chromium`) and sets:
```
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

This avoids downloading a second Chromium binary inside the container and correctly handles all required system library dependencies (`libgbm`, `libatk`, etc.).

---

## What's Implemented

### Core Pipeline ✅
- [x] Puppeteer + axe-core scan (WCAG 2.A/AA)
- [x] Express API with URL validation and SSRF protection
- [x] Groq LLM explanations (JSON-mode, retry on parse failure, graceful fallback)
- [x] BullMQ async job queue with SSE streaming (per-violation live updates)
- [x] MongoDB persistence (scans, violations, explanations)
- [x] Redis scan cache (TTL-based, configurable)
- [x] Redis explanation dedup (reuse LLM output for identical violations across scans)
- [x] React frontend with live-streaming results

### Differentiator Features ✅
- [x] Regression tracking — diff new scan vs previous (fixed/new/unchanged)
- [x] Cost/token transparency — display tokens used + estimated USD cost
- [x] Explanation dedup — skip LLM for violations seen before
- [x] Severity-weighted accessibility score (0–100) with trend line
- [x] Fix-confidence flagging — LLM self-reports high/medium/low confidence
- [x] Exportable shareable HTML report via public link

### Non-Functional ✅
- [x] Rate limiting (Redis-backed, per user/IP)
- [x] SSRF protection (private IP range blocking, DNS validation)
- [x] LLM JSON validation + retry + fallback (never surfaces raw errors)
- [x] JWT auth (signup/login, scan history per user)
- [x] Docker + docker-compose (single `docker compose up --build`)
- [x] Integration test suite

### Stretch Goals
- [ ] Batch/sitemap scanning — planned, not yet implemented
