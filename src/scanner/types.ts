/** Normalized axe-core violation node (one affected element). */
export interface ViolationNode {
  target: string[];
  html: string;
  failureSummary: string;
}

/** Normalized axe-core violation (one rule with one or more nodes). */
export interface AxeViolation {
  id: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor' | null;
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: ViolationNode[];
}

/** Result of a single page accessibility scan. */
export interface ScanResult {
  url: string;
  timestamp: string;
  violations: AxeViolation[];
  violationCount: number;
  incompleteCount: number;
  passesCount: number;
  scanDurationMs: number;
}

export interface ScanOptions {
  /** Navigation timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Wait after load for late JS (default 1500). */
  settleMs?: number;
  /** Puppeteer headless mode (default true). */
  headless?: boolean;
}
