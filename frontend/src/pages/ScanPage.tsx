import { useEffect, useRef, useState, type FormEvent } from 'react';

import {

  api,

  streamJob,

  type JobProgress,

  type ScanResult,

  type ScoreHistoryPoint,

  type Violation,

} from '../lib/api';

import { useAuth } from '../lib/auth';

import { ResultsView } from '../components/ResultsView';

import {

  ComparisonBanner,

  LlmCostPanel,

  ScoreBadge,

  ScoreTrend,

  ShareReportButton,

} from '../components/ScanInsights';



function violationKey(v: Violation): string {

  return `${v.id}:${v.nodes[0]?.target?.join('.') ?? ''}`;

}



export function ScanPage() {

  const { token, user } = useAuth();

  const [url, setUrl] = useState('https://dequeuniversity.com/demo/mars/');

  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState('');

  const [error, setError] = useState('');

  const [result, setResult] = useState<ScanResult | null>(null);

  const [liveViolations, setLiveViolations] = useState<Violation[]>([]);

  const [scoreHistory, setScoreHistory] = useState<ScoreHistoryPoint[]>([]);

  const streamCleanupRef = useRef<(() => void) | null>(null);



  useEffect(() => {

    return () => {

      streamCleanupRef.current?.();

    };

  }, []);



  function upsertViolation(violation: Violation, index?: number) {

    setLiveViolations((prev) => {

      const key = violationKey(violation);

      const existing = prev.findIndex((v) => violationKey(v) === key);

      if (existing >= 0) {

        const next = [...prev];

        next[existing] = violation;

        return next;

      }

      if (index != null && index >= 0 && index <= prev.length) {

        const next = [...prev];

        next[index] = violation;

        return next;

      }

      return [...prev, violation];

    });

  }



  function applyProgress(progress: JobProgress) {

    if (progress.phase === 'scanning' || progress.status === 'scanning') {

      setStatus(progress.message || 'Scanning with axe-core…');

    } else if (progress.phase === 'scan_complete') {

      setStatus(

        progress.message ||

          `Found ${progress.violationCount ?? 0} violation(s) — explaining…`

      );

      if (progress.violations?.length) {

        setLiveViolations(progress.violations);

      }

    } else if (progress.phase === 'explaining') {

      const idx = (progress.index ?? 0) + 1;

      const total = progress.total ?? '?';

      setStatus(progress.message || `Explaining violation ${idx} of ${total}…`);

      if (progress.violation) {

        upsertViolation(progress.violation, progress.index);

      }

    } else if (progress.message) {

      setStatus(progress.message);

    }

  }



  async function onSubmit(e: FormEvent) {

    e.preventDefault();

    setError('');

    setResult(null);

    setLiveViolations([]);

    setScoreHistory([]);

    setBusy(true);

    setStatus('Queueing scan…');



    streamCleanupRef.current?.();

    streamCleanupRef.current = null;



    try {

      const response = await api.enqueueScan(url.trim(), token);

      if ('cached' in response && response.cached) {

        const age = response.cache.ageSeconds ?? 0;

        setStatus(`Cache hit (${age}s old) — skipped re-scan & LLM`);

        setResult(response.result);

        setLiveViolations(response.result.violations);

        loadScoreHistory(response.result.url);

        setBusy(false);

        return;

      }



      const { jobId } = response;

      setStatus(`Job ${jobId} queued…`);



      streamCleanupRef.current = streamJob(jobId, {

        onProgress: applyProgress,

        onViolation: ({ violation, index }) => {

          upsertViolation(violation, index);

        },

        onCompleted: (snap) => {

          setStatus('Complete');

          if (snap.result) {

            setResult(snap.result);

            setLiveViolations(snap.result.violations);

            if (token) loadScoreHistory(snap.result.url);

          }

          setBusy(false);

          streamCleanupRef.current = null;

        },

        onFailed: (payload) => {

          setError(payload.error || 'Scan failed');

          setStatus('Failed');

          setBusy(false);

          streamCleanupRef.current = null;

        },

      });

    } catch (err) {

      setBusy(false);

      setError(err instanceof Error ? err.message : 'Failed to start scan');

    }

  }



  function loadScoreHistory(scanUrl: string) {

    if (!token) return;

    api.getScoreHistory(scanUrl, token).then((r) => setScoreHistory(r.history)).catch(() => {});

  }



  const displayViolations = result?.violations ?? liveViolations;

  const showLiveResults = result || displayViolations.length > 0;



  return (

    <div className="space-y-10">

      <section className="animate-rise max-w-2xl">

        <div className="flex items-center gap-3 mb-2">
          {/* Hero logo mark */}
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-teal shadow-lg shadow-teal/25">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" className="h-8 w-8">
              <circle cx="28" cy="28" r="14" fill="none" stroke="white" strokeWidth="5"/>
              <line x1="38" y1="38" x2="52" y2="52" stroke="white" strokeWidth="6" strokeLinecap="round"/>
              <text x="28" y="34" textAnchor="middle" fontFamily="Arial Black, sans-serif" fontWeight="900" fontSize="18" fill="white">A</text>
            </svg>
          </span>
          <p className="text-sm font-medium uppercase tracking-[0.14em] text-teal">

            Accessibility auditor

          </p>
        </div>

        <h1 className="mt-2 font-display text-4xl font-bold leading-tight text-teal-deep sm:text-5xl">

          AuditAlly

        </h1>

        <p className="mt-3 text-lg text-ink/70">

          Deterministic axe-core detection, plain-language AI explanations. Paste a

          public URL to scan.

        </p>



        <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-3 sm:flex-row">

          <input

            type="url"

            required

            value={url}

            onChange={(e) => setUrl(e.target.value)}

            placeholder="https://example.com"

            className="min-w-0 flex-1 rounded-md border border-mist bg-white px-4 py-3 text-base outline-none focus:border-teal"

            disabled={busy}

          />

          <button

            type="submit"

            disabled={busy}

            className="rounded-md bg-accent px-6 py-3 font-semibold text-white hover:brightness-95 disabled:opacity-60"

          >

            {busy ? 'Scanning…' : 'Run scan'}

          </button>

        </form>



        {!user && (

          <p className="mt-3 text-sm text-ink/50">

            Tip: <a className="underline" href="/signup">sign up</a> to save results to

            history.

          </p>

        )}



        {busy && (

          <div className="mt-5">

            <div className="h-1.5 overflow-hidden rounded bg-mist">

              <div className="animate-pulse-bar h-full w-2/3 rounded bg-teal" />

            </div>

            <p className="mt-2 text-sm text-ink/65">{status}</p>

            {liveViolations.length > 0 && !result && (

              <p className="mt-1 text-xs text-teal-deep">

                {liveViolations.filter((v) => v.explanation).length} of{' '}

                {liveViolations.length} explained live…

              </p>

            )}

          </div>

        )}



        {error && (

          <p className="mt-4 rounded-md border border-critical/30 bg-critical/10 px-3 py-2 text-sm text-critical">

            {error}

          </p>

        )}

      </section>



      {showLiveResults && (

        <div className="space-y-4">

          <div className="flex flex-wrap items-start gap-4">

            <ScoreBadge score={result?.accessibilityScore} />

            {scoreHistory.length >= 2 && <ScoreTrend history={scoreHistory} />}

          </div>

          <ComparisonBanner comparison={result?.comparison} />

          <LlmCostPanel

            llm={result?.llm}

            llmCostUsd={result?.llmCostUsd}

            llmReusedCount={result?.llmReusedCount}

          />

          {user && result?.scanId && (

            <ShareReportButton scanId={result.scanId} token={token} />

          )}

          <ResultsView

            url={result?.url || url}

            violations={displayViolations}

            meta={{

              durationMs: result?.scanDurationMs,

              mock: result?.llm?.mock,

              scanId: result?.scanId,

            }}

          />

        </div>

      )}



      {status.includes('Cache hit') && (

        <p className="text-sm text-teal-deep">{status}</p>

      )}

    </div>

  );

}


