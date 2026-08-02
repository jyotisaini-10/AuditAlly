import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type ScanResult, type ScanSummary, type ScoreHistoryPoint } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ResultsView } from '../components/ResultsView';
import {
  ComparisonBanner,
  LlmCostPanel,
  ScoreBadge,
  ScoreTrend,
  ShareReportButton,
} from '../components/ScanInsights';

export function HistoryPage() {
  const { token, user, loading } = useAuth();
  const navigate = useNavigate();
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (!user || !token) {
      navigate('/login');
      return;
    }
    setBusy(true);
    api
      .listScans(token)
      .then((res) => setScans(res.scans))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setBusy(false));
  }, [user, token, loading, navigate]);

  if (loading || busy) {
    return <p className="text-ink/60">Loading history…</p>;
  }

  return (
    <section className="animate-rise space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold text-teal-deep">Past scans</h1>
        <p className="text-ink/60">Your saved accessibility audits.</p>
      </div>

      {error && <p className="text-critical">{error}</p>}

      {scans.length === 0 ? (
        <p className="text-ink/60">
          No scans yet. <Link to="/" className="text-teal-deep underline">Run one</Link>.
        </p>
      ) : (
        <ul className="divide-y divide-mist rounded-xl border border-mist bg-paper/80">
          {scans.map((s) => (
            <li key={s.id}>
              <Link
                to={`/history/${s.id}`}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-mist/40"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.url}</p>
                  <p className="text-xs text-ink/50">
                    {new Date(s.scannedAt).toLocaleString()}
                  </p>
                </div>
                <span className="rounded border border-mist px-2 py-1 text-sm">
                  {s.accessibilityScore != null ? `${s.accessibilityScore}/100 · ` : ''}
                  {s.violationCount} issue{s.violationCount === 1 ? '' : 's'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HistoryDetailPage() {
  const { id } = useParams();
  const { token, user, loading } = useAuth();
  const navigate = useNavigate();
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scoreHistory, setScoreHistory] = useState<ScoreHistoryPoint[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (loading) return;
    if (!user || !token || !id) {
      navigate('/login');
      return;
    }
    api
      .getScan(id, token)
      .then((data) => {
        setScan(data);
        return api.getScoreHistory(data.url, token);
      })
      .then((hist) => setScoreHistory(hist.history))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [id, user, token, loading, navigate]);

  if (error) return <p className="text-critical">{error}</p>;
  if (!scan) return <p className="text-ink/60">Loading scan…</p>;

  return (
    <div className="space-y-4">
      <Link to="/history" className="text-sm text-teal-deep underline">
        ← Back to history
      </Link>
      <div className="flex flex-wrap items-start gap-4">
        <ScoreBadge score={scan.accessibilityScore} />
        {scoreHistory.length >= 2 && <ScoreTrend history={scoreHistory} />}
      </div>
      <ComparisonBanner comparison={scan.comparison} />
      <LlmCostPanel
        llm={scan.llm}
        llmCostUsd={scan.llmCostUsd}
        llmReusedCount={scan.llmReusedCount}
      />
      <ShareReportButton scanId={scan.scanId || id} token={token} />
      <ResultsView
        url={scan.url}
        violations={scan.violations || []}
        meta={{
          durationMs: scan.scanDurationMs,
          mock: scan.llm?.mock,
          scanId: scan.scanId || id,
        }}
      />
    </div>
  );
}
