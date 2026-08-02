const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type Confidence = 'high' | 'medium' | 'low';

export interface ViolationExplanation {
  plainLanguageExplanation: string;
  whyItMatters: string;
  suggestedFixCode: string;
  severity: Severity;
  confidence: Confidence;
  isFallback?: boolean;
  confidenceNote?: string;
}

export interface Violation {
  id: string;
  impact: Severity | null;
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: Array<{
    target: string[];
    html: string;
    failureSummary: string;
  }>;
  explanation?: ViolationExplanation;
}

export interface ScanResult {
  url: string;
  timestamp: string;
  violationCount: number;
  incompleteCount: number;
  passesCount: number;
  scanDurationMs: number;
  violations: Violation[];
  accessibilityScore?: number;
  scoreBreakdown?: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    penalty: number;
  };
  comparison?: ScanComparison;
  llmCostUsd?: number;
  llmReusedCount?: number;
  llm?: {
    enabled: boolean;
    mock: boolean;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      model: string;
    };
  };
  scanId?: string;
}

export interface ScanComparison {
  previousScanId: string | null;
  fixed: number;
  new: number;
  unchanged: number;
}

export interface ScoreHistoryPoint {
  scanId: string;
  scannedAt: string;
  score: number;
  violationCount: number;
}

export interface JobProgress {
  status?: string;
  phase?: string;
  message?: string;
  index?: number;
  total?: number;
  violationCount?: number;
  url?: string;
  scanDurationMs?: number;
  violations?: Violation[];
  violation?: Violation;
}

export interface JobSnapshot {
  id: string;
  status: 'queued' | 'scanning' | 'explaining' | 'completed' | 'failed' | 'unknown';
  progress: JobProgress | null;
  result?: ScanResult;
  failedReason?: string;
}

export interface ScanSummary {
  id: string;
  url: string;
  scannedAt: string;
  violationCount: number;
  accessibilityScore?: number;
  status: string;
  jobId?: string;
  scanDurationMs?: number;
}

async function request<T>(
  path: string,
  opts: RequestInit & { token?: string | null } = {}
): Promise<T> {
  const { token, headers, ...rest } = opts;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.detail || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  signup: (email: string, password: string, name?: string) =>
    request<{ user: { id: string; email: string; name?: string }; token: string }>(
      '/auth/signup',
      { method: 'POST', body: JSON.stringify({ email, password, name }) }
    ),

  login: (email: string, password: string) =>
    request<{ user: { id: string; email: string; name?: string }; token: string }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) }
    ),

  me: (token: string) =>
    request<{ id: string; email: string; name?: string }>('/auth/me', { token }),

  enqueueScan: (url: string, token?: string | null, force?: boolean) =>
    request<
      | {
          jobId: string;
          statusUrl: string;
          streamUrl: string;
          cached: false;
        }
      | {
          cached: true;
          cache: {
            hit: boolean;
            ageSeconds?: number;
            ttlSeconds: number;
            cachedAt?: string;
          };
          result: ScanResult;
        }
    >('/scan', {
      method: 'POST',
      body: JSON.stringify({ url, force: force === true }),
      token,
    }),

  getJob: (jobId: string) => request<JobSnapshot>(`/scan/${jobId}`),

  listScans: (token: string) =>
    request<{ total: number; scans: ScanSummary[] }>('/scans', { token }),

  getScan: (id: string, token: string) =>
    request<ScanResult & { _id: string; scannedAt: string }>('/scans/' + id, {
      token,
    }),

  getScoreHistory: (url: string, token: string) =>
    request<{ url: string; history: ScoreHistoryPoint[] }>(
      `/scans/score-history?url=${encodeURIComponent(url)}`,
      { token }
    ),

  shareScan: (id: string, token: string) =>
    request<{ shareToken: string; reportUrl: string }>(`/scans/${id}/share`, {
      method: 'POST',
      token,
    }),
};

export type JobStreamHandlers = {
  onProgress?: (progress: JobProgress) => void;
  onViolation?: (payload: {
    index?: number;
    total?: number;
    violation: Violation;
  }) => void;
  onCompleted?: (snapshot: JobSnapshot) => void;
  onFailed?: (payload: { jobId: string; error: string }) => void;
};

/** Subscribe to job SSE (progress + per-violation explanations). Returns cleanup fn. */
export function streamJob(jobId: string, handlers: JobStreamHandlers): () => void {
  const source = new EventSource(`${API_BASE}/scan/${jobId}/stream`);

  source.addEventListener('progress', (ev) => {
    try {
      const progress = JSON.parse((ev as MessageEvent).data) as JobProgress;
      handlers.onProgress?.(progress);
      if (progress.phase === 'scan_complete' && progress.violations?.length) {
        for (let i = 0; i < progress.violations.length; i++) {
          handlers.onViolation?.({
            index: i,
            total: progress.violations.length,
            violation: progress.violations[i],
          });
        }
      }
    } catch {
      /* ignore malformed */
    }
  });

  source.addEventListener('violation', (ev) => {
    try {
      handlers.onViolation?.(JSON.parse((ev as MessageEvent).data));
    } catch {
      /* ignore */
    }
  });

  source.addEventListener('completed', (ev) => {
    try {
      handlers.onCompleted?.(JSON.parse((ev as MessageEvent).data));
    } catch {
      /* ignore */
    }
    source.close();
  });

  source.addEventListener('failed', (ev) => {
    try {
      handlers.onFailed?.(JSON.parse((ev as MessageEvent).data));
    } catch {
      handlers.onFailed?.({ jobId, error: 'Stream failed' });
    }
    source.close();
  });

  source.onerror = () => {
    handlers.onFailed?.({ jobId, error: 'Connection lost' });
    source.close();
  };

  return () => source.close();
}
