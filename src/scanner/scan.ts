import puppeteer, { Browser, Page } from 'puppeteer';
import axeCore from 'axe-core';
import type { AxeViolation, ScanOptions, ScanResult, ViolationNode } from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_MS = 1_500;

/**
 * Launch headless Chrome, load `url`, inject axe-core, run WCAG 2.A/AA audit.
 * Deterministic detection only — no LLM involved.
 */
export async function scanUrl(
  url: string,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const headless = options.headless ?? true;

  validateUrl(url);

  const startedAt = Date.now();
  let browser: Browser | null = null;

  try {
    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined;

    browser = await puppeteer.launch({
      headless,
      ...(executablePath ? { executablePath } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Soften some bot checks without spoofing beyond a normal browser UA.
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Many production sites (e.g. w3.org) block inline scripts via CSP.
    // Bypass CSP so we can inject the bundled axe-core source.
    await page.setBypassCSP(true);

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: timeoutMs,
    });

    // Prefer bundled axe source (offline-friendly) over CDN.
    await page.addScriptTag({ content: axeCore.source });

    if (settleMs > 0) {
      await sleep(page, settleMs);
    }

    // page.evaluate runs in the browser; keep this callback free of DOM lib types.
    const axeResults = await page.evaluate(async () => {
      const g = globalThis as unknown as {
        axe?: {
          run: (
            context: unknown,
            options: { runOnly: { type: string; values: string[] } }
          ) => Promise<{
            violations: Array<{
              id: string;
              impact?: string | null;
              description: string;
              help: string;
              helpUrl: string;
              tags: string[];
              nodes: Array<{
                target: string[];
                html: string;
                failureSummary?: string;
              }>;
            }>;
            incomplete?: unknown[];
            passes?: unknown[];
          }>;
        };
        document: unknown;
      };

      if (!g.axe || typeof g.axe.run !== 'function') {
        throw new Error('axe-core failed to inject into the page');
      }

      return g.axe.run(g.document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        },
      });
    });

    const violations: AxeViolation[] = axeResults.violations.map((v) => ({
      id: v.id,
      impact: (v.impact as AxeViolation['impact']) ?? null,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      tags: v.tags,
      nodes: v.nodes.map(
        (node): ViolationNode => ({
          target: node.target,
          html: node.html,
          failureSummary: node.failureSummary ?? '',
        })
      ),
    }));

    return {
      url,
      timestamp: new Date().toISOString(),
      violations,
      violationCount: violations.length,
      incompleteCount: axeResults.incomplete?.length ?? 0,
      passesCount: axeResults.passes?.length ?? 0,
      scanDurationMs: Date.now() - startedAt,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http/https URLs are supported (got ${parsed.protocol})`);
  }
}

function sleep(page: Page, ms: number): Promise<void> {
  // Avoid deprecated page.waitForTimeout — use evaluate + setTimeout.
  return page.evaluate(
    (delay) => new Promise<void>((resolve) => setTimeout(resolve, delay)),
    ms
  );
}

