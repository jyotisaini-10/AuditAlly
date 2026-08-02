import { useState } from 'react';
import { api, type ScanComparison, type ScoreHistoryPoint, type ScanResult } from '../lib/api';

export function ScoreBadge({ score }: { score?: number }) {
  if (score == null) return null;
  const color =
    score >= 80 ? 'text-teal-deep border-teal/30 bg-teal/8' :
    score >= 60 ? 'text-moderate border-moderate/30 bg-moderate/8' :
    score >= 40 ? 'text-serious border-serious/30 bg-serious/8' :
    'text-critical border-critical/30 bg-critical/8';

  return (
    <div className={`inline-flex flex-col items-center rounded-xl border px-4 py-2 ${color}`}>
      <span className="text-xs uppercase tracking-wide opacity-70">Accessibility score</span>
      <span className="font-display text-3xl font-bold">{score}</span>
      <span className="text-xs opacity-60">out of 100</span>
    </div>
  );
}

export function ComparisonBanner({
  comparison,
}: {
  comparison?: ScanComparison | null;
}) {
  if (!comparison || !comparison.previousScanId) return null;

  return (
    <div className="rounded-lg border border-teal/20 bg-teal/5 px-4 py-3 text-sm">
      <p className="font-medium text-teal-deep">Regression vs previous scan</p>
      <p className="mt-1 text-ink/70">
        <span className="text-teal-deep font-semibold">{comparison.fixed} fixed</span>
        {' · '}
        <span className="text-critical font-semibold">{comparison.new} new</span>
        {' · '}
        <span className="text-ink/60">{comparison.unchanged} unchanged</span>
      </p>
    </div>
  );
}

export function LlmCostPanel({
  llm,
  llmCostUsd,
  llmReusedCount,
}: {
  llm?: ScanResult['llm'];
  llmCostUsd?: number;
  llmReusedCount?: number;
}) {
  if (!llm?.enabled && llmCostUsd == null) return null;

  return (
    <div className="rounded-lg border border-mist bg-paper/60 px-4 py-3 text-sm">
      <p className="font-medium text-ink/80">LLM usage</p>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-ink/60">
        {llm?.usage && (
          <>
            <span>{llm.usage.totalTokens.toLocaleString()} tokens</span>
            <span>model: {llm.usage.model}</span>
          </>
        )}
        {llmCostUsd != null && (
          <span>est. cost: ${llmCostUsd.toFixed(4)}</span>
        )}
        {(llmReusedCount ?? 0) > 0 && (
          <span className="text-teal-deep">
            {llmReusedCount} explanation{llmReusedCount === 1 ? '' : 's'} reused from cache
          </span>
        )}
      </div>
    </div>
  );
}

export function ScoreTrend({ history }: { history: ScoreHistoryPoint[] }) {
  if (history.length < 2) return null;

  const scores = history.map((h) => h.score);
  const min = Math.min(...scores, 0);
  const max = Math.max(...scores, 100);
  const range = max - min || 1;
  const w = 280;
  const h = 64;

  const points = history
    .map((pt, i) => {
      const x = (i / (history.length - 1)) * w;
      const y = h - ((pt.score - min) / range) * (h - 8) - 4;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="rounded-lg border border-mist bg-paper/60 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink/50">
        Score trend ({history.length} scans)
      </p>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 w-full max-w-xs" aria-hidden>
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-teal"
          points={points}
        />
      </svg>
      <p className="mt-1 text-xs text-ink/50">
        {history[0].score} → {history[history.length - 1].score}
      </p>
    </div>
  );
}

export function ShareReportButton({
  scanId,
  token,
}: {
  scanId?: string;
  token: string | null;
}) {
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!scanId || !token) return null;

  async function onShare() {
    setBusy(true);
    setError('');
    try {
      const res = await api.shareScan(scanId!, token!);
      setReportUrl(res.reportUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Share failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onShare}
        disabled={busy}
        className="rounded-md border border-teal/30 px-3 py-1.5 text-sm text-teal-deep hover:bg-teal/5 disabled:opacity-60"
      >
        {busy ? 'Creating link…' : 'Export / share report'}
      </button>
      {reportUrl && (
        <a
          href={reportUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-teal-deep underline break-all"
        >
          Open report
        </a>
      )}
      {error && <span className="text-sm text-critical">{error}</span>}
    </div>
  );
}
