import type { Confidence, Severity, Violation } from '../lib/api';

const SEVERITY_ORDER: Severity[] = ['critical', 'serious', 'moderate', 'minor'];

const severityStyles: Record<Severity, string> = {
  critical: 'border-critical/30 bg-critical/8 text-critical',
  serious: 'border-serious/30 bg-serious/8 text-serious',
  moderate: 'border-moderate/30 bg-moderate/8 text-moderate',
  minor: 'border-minor/30 bg-minor/8 text-minor',
};

const confidenceStyles: Record<Confidence, string> = {
  high: 'text-teal-deep',
  medium: 'text-serious',
  low: 'text-critical',
};

function severityOf(v: Violation): Severity {
  return v.explanation?.severity || v.impact || 'moderate';
}

export function groupBySeverity(violations: Violation[]): Record<Severity, Violation[]> {
  const groups: Record<Severity, Violation[]> = {
    critical: [],
    serious: [],
    moderate: [],
    minor: [],
  };
  for (const v of violations) {
    groups[severityOf(v)].push(v);
  }
  return groups;
}

export function ResultsView({
  url,
  violations,
  meta,
}: {
  url: string;
  violations: Violation[];
  meta?: { durationMs?: number; mock?: boolean; scanId?: string };
}) {
  const groups = groupBySeverity(violations);

  return (
    <section className="animate-rise space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-mist pb-4">
        <div>
          <p className="text-sm uppercase tracking-wide text-ink/50">Results</p>
          <h2 className="font-display text-2xl font-semibold text-ink break-all">{url}</h2>
          <p className="mt-1 text-sm text-ink/60">
            {violations.length} violation{violations.length === 1 ? '' : 's'}
            {meta?.durationMs != null ? ` · ${meta.durationMs}ms` : ''}
            {meta?.mock ? ' · mock explanations' : ''}
          </p>
        </div>
        <SeverityLegend groups={groups} />
      </div>

      {violations.length === 0 ? (
        <p className="rounded-lg border border-teal/20 bg-teal/5 px-4 py-6 text-teal-deep">
          No WCAG 2.A/AA violations found by axe-core on this page.
        </p>
      ) : (
        SEVERITY_ORDER.map((sev) =>
          groups[sev].length === 0 ? null : (
            <div key={sev} className="space-y-3">
              <h3 className="flex items-center gap-2 font-display text-xl capitalize">
                <span className={`rounded border px-2 py-0.5 text-sm ${severityStyles[sev]}`}>
                  {sev}
                </span>
                <span className="text-ink/50 text-base font-sans">
                  {groups[sev].length}
                </span>
              </h3>
              {groups[sev].map((v) => (
                <ViolationCard key={v.id + (v.nodes[0]?.target?.join('.') || '')} violation={v} />
              ))}
            </div>
          )
        )
      )}
    </section>
  );
}

function SeverityLegend({
  groups,
}: {
  groups: Record<Severity, Violation[]>;
}) {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {SEVERITY_ORDER.map((sev) => (
        <span key={sev} className={`rounded border px-2 py-1 capitalize ${severityStyles[sev]}`}>
          {sev}: {groups[sev].length}
        </span>
      ))}
    </div>
  );
}

function ViolationCard({ violation }: { violation: Violation }) {
  const exp = violation.explanation;
  const before = violation.nodes[0]?.html || '';
  const after = exp?.suggestedFixCode || '';
  const confidence = exp?.confidence || 'low';

  return (
    <article className="animate-rise rounded-xl border border-mist bg-paper/80 p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="font-semibold text-ink">{violation.id}</h4>
          <p className="text-sm text-ink/65">{violation.help}</p>
        </div>
        <div className={`text-xs font-medium ${confidenceStyles[confidence]}`}>
          {confidence} confidence
          {exp?.isFallback ? ' · fallback' : ''}
        </div>
      </div>

      {exp && (
        <div className="mt-3 space-y-2 text-sm">
          <p>
            <span className="font-medium text-ink">What&apos;s wrong: </span>
            {exp.plainLanguageExplanation}
          </p>
          <p>
            <span className="font-medium text-ink">Why it matters: </span>
            {exp.whyItMatters}
          </p>
          {exp.confidenceNote && (
            <p className="text-ink/55 italic">{exp.confidenceNote}</p>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <CodeBlock label="Before" code={before} />
        <CodeBlock label="Suggested fix" code={after || '—'} />
      </div>

      {violation.nodes[0]?.target?.length ? (
        <p className="mt-3 font-mono text-xs text-ink/45">
          {violation.nodes[0].target.join(' ')}
        </p>
      ) : null}
    </article>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink/45">
        {label}
      </p>
      <pre className="max-h-48 overflow-auto rounded-lg bg-ink px-3 py-2 text-xs leading-relaxed text-mist whitespace-pre-wrap break-all">
        {code || '(empty)'}
      </pre>
    </div>
  );
}
