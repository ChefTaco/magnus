'use client';
import { useState } from 'react';
export function EvidenceReview() {
  const [incidentId, setIncidentId] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [symptom, setSymptom] = useState('');
  const [cause, setCause] = useState('');
  const [evidenceId, setEvidenceId] = useState('');
  const [runbook, setRunbook] = useState('diagnostics.v1');
  async function request(path: string, body?: unknown) {
    setError('');
    const res = await fetch(
      `/api/proxy/ops/${path}`,
      body
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {},
    );
    const value = await res.json();
    if (!res.ok) throw new Error(value.error?.message ?? `HTTP ${res.status}`);
    return value.data;
  }
  return (
    <section className="rounded border border-border p-4 space-y-3">
      <h2>Export evidence or review an incident lesson</h2>
      <p className="text-xs text-text-muted">
        Enter the anomaly ID from the anomaly ledger. Reviewed lessons need a completed runbook
        execution; they never execute actions.
      </p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <input
        aria-label="Incident ID"
        placeholder="Anomaly ID"
        value={incidentId}
        onChange={(e) => setIncidentId(e.target.value)}
      />
      <button
        className="ml-2 underline"
        disabled={!incidentId}
        onClick={() =>
          void request(`incidents/${encodeURIComponent(incidentId)}/evidence`)
            .then((v) => {
              setOutput(v.markdown);
              const url = URL.createObjectURL(new Blob([v.markdown], { type: 'text/markdown' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = 'magnus-incident-evidence.md';
              a.click();
              URL.revokeObjectURL(url);
            })
            .catch((e) => setError(String(e)))
        }
      >
        Download evidence packet
      </button>
      <details>
        <summary>Review and publish a lesson</summary>
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void request('lessons', {
              incidentId,
              symptom,
              cause,
              runbookVersion: runbook,
              evidenceIds: [evidenceId],
              expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
              reviewed: true,
            })
              .then((v) => setOutput(JSON.stringify(v, null, 2)))
              .catch((e) => setError(String(e)));
          }}
        >
          <input
            aria-label="Reviewed symptom"
            placeholder="Sanitized symptom"
            required
            minLength={5}
            value={symptom}
            onChange={(e) => setSymptom(e.target.value)}
          />
          <textarea
            aria-label="Verified cause"
            placeholder="Verified cause; exclude raw logs and private evidence"
            required
            minLength={5}
            value={cause}
            onChange={(e) => setCause(e.target.value)}
          />
          <input
            aria-label="Successful execution ID"
            placeholder="Completed runbook execution ID"
            required
            value={evidenceId}
            onChange={(e) => setEvidenceId(e.target.value)}
          />
          <select
            aria-label="Runbook version"
            value={runbook}
            onChange={(e) => setRunbook(e.target.value)}
          >
            <option>diagnostics.v1</option>
            <option>restart-service.v1</option>
          </select>
          <label>
            <input type="checkbox" required /> I reviewed the cause and evidence, removed private
            content, and approve publication with a 30-day expiry.
          </label>
          <button className="rounded border border-primary p-2">Publish reviewed lesson</button>
        </form>
      </details>
      <button
        className="underline"
        onClick={() =>
          void request(`lessons?${new URLSearchParams({ query: symptom || 'worker' })}`)
            .then((v) => setOutput(JSON.stringify(v, null, 2)))
            .catch((e) => setError(String(e)))
        }
      >
        Find current lessons matching the symptom
      </button>
      {output && <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{output}</pre>}
    </section>
  );
}
