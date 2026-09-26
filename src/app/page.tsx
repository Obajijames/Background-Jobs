"use client";

import { useEffect, useState } from "react";

interface Section {
  heading: string;
  body: string;
}

interface EnqueueResult {
  status: string;
  body: unknown;
}

interface DeadJob {
  id: string;
  type: string;
  payloadSummary: { reportTitle: string | null; sectionCount: number | null };
  attempts: number;
  lastError: string | null;
  runAt: string;
  finishedAt: string | null;
  createdAt: string;
}

const TERMINAL_STATUSES = ["succeeded", "dead"];
const CLIENT_ID_KEY = "pdfjobs.clientId";
const RECENT_JOBS_KEY = "pdfjobs.recentJobs";

const DEFAULT_SECTIONS: Section[] = [
  {
    heading: "Executive Summary",
    body:
      "This report summarizes the findings for the requested analysis period. Key observations are documented across the following sections, with supporting detail for each recommendation made at the close of the document. Every paragraph is intentionally written to be long enough to demonstrate genuine multi-page PDF generation rather than a trivial single-page stub.",
  },
  {
    heading: "Methodology",
    body:
      "Data was collected from primary and secondary sources, normalized into a consistent schema, and validated before analysis. Outliers were reviewed manually and excluded only when a documented defect was identified. All processing steps were performed deterministically so that re-running the same job with the same input yields the same logical output.",
  },
  {
    heading: "Conclusions",
    body:
      "The evidence supports the recommendations in the closing section. Follow-up work should track each recommendation to completion and revisit the remaining risks quarterly. The appendix lists every reference consulted during the preparation of this document for auditability and reproducibility of the analysis method.",
  },
];

function readStorage<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStorage<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage may be unavailable; panel still works for this session
  }
}

function getOrCreateClientId(): string {
  const existing = readStorage<string>(CLIENT_ID_KEY);
  if (existing) return existing;
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `anon-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeStorage(CLIENT_ID_KEY, id);
  return id;
}

export default function Page() {
  const [clientId, setClientId] = useState<string | null>(null);
  const [recentJobs, setRecentJobs] = useState<string[]>([]);

  const [idemKey, setIdemKey] = useState("");
  const [reportTitle, setReportTitle] = useState("Manual Test Report");
  const [failAttempts, setFailAttempts] = useState(0);
  const [sections, setSections] = useState<Section[]>(DEFAULT_SECTIONS);
  const [newHeading, setNewHeading] = useState("");
  const [newBody, setNewBody] = useState("");

  const [enqueue, setEnqueue] = useState<EnqueueResult | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const [statusJobId, setStatusJobId] = useState("");
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobDetail, setJobDetail] = useState<unknown | null>(null);

  const [deadJobs, setDeadJobs] = useState<DeadJob[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setClientId(getOrCreateClientId());
      setRecentJobs(readStorage<string[]>(RECENT_JOBS_KEY) ?? []);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  async function postJson(
    url: string,
    body: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<{ _status: number; _body: unknown }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(clientId ? { "X-Client-Id": clientId } : {}),
      ...extraHeaders,
    };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const _body = await res.json().catch(() => null);
    return { _status: res.status, _body };
  }

  function rememberJob(id: string): void {
    setRecentJobs((prev) => {
      const next = [id, ...prev.filter((j) => j !== id)].slice(0, 10);
      writeStorage(RECENT_JOBS_KEY, next);
      return next;
    });
  }

  async function handleEnqueue(): Promise<void> {
    setApiError(null);
    const key =
      idemKey.trim() ||
      `${clientId ? clientId.slice(0, 8) : "anon"}-${Date.now().toString(36)}`;
    const payload: Record<string, unknown> = {
      reportTitle,
      sections: sections.map((s) => ({
        heading: s.heading,
        body: s.body
          .split("\n")
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
      })),
    };
    if (failAttempts > 0) {
      payload._testFailure = { attemptsToFail: failAttempts };
    }
    try {
      const result = await postJson("/api/jobs", payload, {
        "Idempotency-Key": key,
      });
      setEnqueue({ status: String(result._status), body: result._body });
      if (result._status === 202) {
        const id = (result._body as { id: string }).id;
        setStatusJobId(id);
        setJobStatus("pending");
        setJobDetail(null);
        rememberJob(id);
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!statusJobId || !jobStatus) return;
    const timer = setInterval(async () => {
      try {
        const headers: Record<string, string> = clientId
          ? { "X-Client-Id": clientId }
          : {};
        const res = await fetch(`/api/jobs/${statusJobId}`, { headers });
        const data = (await res.json()) as { status?: string };
        setJobStatus(data.status ?? null);
        setJobDetail(data);
        if (res.status === 404 || TERMINAL_STATUSES.includes(data.status ?? "")) {
          clearInterval(timer);
        }
      } catch {
        clearInterval(timer);
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [statusJobId, jobStatus, clientId]);

  async function refreshDead(): Promise<void> {
    const headers: Record<string, string> = clientId
      ? { "X-Client-Id": clientId }
      : {};
    const res = await fetch("/api/jobs/dead", { headers });
    const data = (await res.json()) as { jobs: DeadJob[] };
    setDeadJobs(data.jobs ?? []);
  }

  async function retryDead(id: string): Promise<void> {
    await postJson(`/api/jobs/${id}/retry`, {});
    await refreshDead();
  }

  async function watchJob(id: string): Promise<void> {
    setStatusJobId(id);
    setJobStatus("pending");
    setJobDetail(null);
  }

  function addSection(): void {
    const heading = newHeading.trim();
    const body = newBody.trim();
    if (!heading || !body) return;
    setSections((prev) => [...prev, { heading, body }]);
    setNewHeading("");
    setNewBody("");
  }

  function defaultIdemKey(): string {
    const prefix = clientId ? clientId.slice(0, 8) : "anon";
    return `${prefix}-auto`;
  }

  return (
    <main style={styles.main}>
      <div style={styles.banner}>
        <h1 style={styles.pageTitle}>PDF Job System — Test Console</h1>
        <span style={styles.badge}>
          {clientId
            ? `Recognized as ${clientId.slice(0, 8)}…`
            : "initializing…"}
        </span>
      </div>

      <section style={styles.card}>
        <h2 style={styles.cardTitle}>1 · Enqueue a job</h2>
        <label style={styles.label}>
          Idempotency-Key
          <input
            style={styles.input}
            placeholder={defaultIdemKey()}
            value={idemKey}
            onChange={(e) => setIdemKey(e.target.value)}
          />
        </label>
        <span style={styles.hint}>
          Leave empty for an identity-scoped auto key.
        </span>
        <label style={styles.label}>
          Report title
          <input
            style={styles.input}
            value={reportTitle}
            onChange={(e) => setReportTitle(e.target.value)}
          />
        </label>
        <label style={styles.label}>
          Failures to simulate (0 = normal, 100 = fail until dead)
          <select
            style={styles.input}
            value={failAttempts}
            onChange={(e) => setFailAttempts(Number(e.target.value))}
          >
            <option value={0}>0 — succeed</option>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={4}>4</option>
            <option value={100}>100 — always fail (to dead)</option>
          </select>
        </label>

        <h3 style={styles.smallTitle}>Sections (min 3)</h3>
        {sections.map((s, i) => (
          <div key={i} style={styles.sectionRow}>
            <strong style={styles.sectionHead}>{s.heading}</strong>
            <button
              style={styles.linkButton}
              onClick={() =>
                setSections((prev) => prev.filter((_, j) => j !== i))
              }
            >
              remove
            </button>
          </div>
        ))}
        <div style={styles.addRow}>
          <input
            style={styles.input}
            placeholder="New heading"
            value={newHeading}
            onChange={(e) => setNewHeading(e.target.value)}
          />
          <input
            style={styles.input}
            placeholder="Body — paragraphs, one per line"
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
          />
          <button style={styles.ghostButton} onClick={addSection}>
            Add section
          </button>
        </div>

        <button style={styles.button} onClick={() => void handleEnqueue()}>
          Enqueue
        </button>
        {apiError && <pre style={styles.error}>{apiError}</pre>}
        {enqueue && (
          <pre style={styles.pre}>
            HTTP {enqueue.status}
            {"\n"}
            {JSON.stringify(enqueue.body, null, 2)}
          </pre>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={styles.cardTitle}>2 · Job status (auto-polling)</h2>
        {recentJobs.length > 0 && (
          <>
            <span style={styles.hint}>Your recent jobs:</span>
            <div style={styles.history}>
              {recentJobs.map((id) => (
                <button key={id} style={styles.ghostButton} onClick={() => void watchJob(id)}>
                  {id.slice(0, 10)}…
                </button>
              ))}
            </div>
          </>
        )}
        {statusJobId ? (
          <>
            <p style={styles.muted}>
              Job <code>{statusJobId}</code> · Status:{" "}
              <strong>{jobStatus ?? "waiting…"}</strong>
            </p>
            {jobDetail && <pre style={styles.pre}>{JSON.stringify(jobDetail, null, 2)}</pre>}
          </>
        ) : (
          <p style={styles.muted}>Enqueue a job to watch its status here.</p>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={styles.cardTitle}>3 · Dead-letter view</h2>
        <button style={styles.ghostButton} onClick={() => void refreshDead()}>
          Refresh dead jobs
        </button>
        {deadJobs.length === 0 ? (
          <p style={styles.muted}>No dead jobs.</p>
        ) : (
          deadJobs.map((j) => (
            <div key={j.id} style={styles.deadRow}>
              <code style={styles.deadId}>{j.id}</code>
              <span style={styles.muted}>
                attempts {j.attempts} · {j.payloadSummary.reportTitle ?? "n/a"}
                {j.lastError ? ` · ${j.lastError}` : ""}
              </span>
              <button
                style={styles.linkButton}
                onClick={() => void retryDead(j.id)}
              >
                Retry
              </button>
            </div>
          ))
        )}
      </section>

      <footer style={styles.footer}>
        Internal debug panel · identifies you by a locally generated id — no
        authentication · talks only to the four §8 API routes.
      </footer>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    maxWidth: 860,
    margin: "0 auto",
    padding: "2rem 1.5rem 3rem",
    fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
    color: "#d4d4d8",
  },
  banner: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    marginBottom: "1.5rem",
  },
  pageTitle: { fontSize: "1.35rem", color: "#fafafa" },
  badge: {
    fontSize: "0.75rem",
    color: "#a1a1aa",
    border: "1px solid #3f3f46",
    borderRadius: 999,
    padding: "0.25rem 0.7rem",
    whiteSpace: "nowrap",
  },
  card: {
    border: "1px solid #333",
    borderRadius: 8,
    padding: "1.25rem",
    marginBottom: "1.25rem",
    background: "#171717",
  },
  cardTitle: { fontSize: "1rem", marginBottom: "1rem", color: "#fafafa" },
  smallTitle: { fontSize: "0.85rem", margin: "1rem 0 0.5rem", color: "#a1a1aa" },
  label: { display: "block", marginBottom: "0.75rem", fontSize: "0.82rem" },
  hint: { display: "block", fontSize: "0.72rem", color: "#71717a", margin: "-0.4rem 0 0.75rem" },
  input: {
    display: "block",
    width: "100%",
    marginTop: "0.25rem",
    padding: "0.4rem 0.55rem",
    background: "#222222",
    color: "#e4e4e7",
    border: "1px solid #3f3f46",
    borderRadius: 4,
    fontSize: "0.85rem",
  },
  button: {
    marginTop: "0.75rem",
    padding: "0.5rem 1.1rem",
    background: "#3b82f6",
    color: "#ffffff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: "0.85rem",
  },
  ghostButton: {
    padding: "0.3rem 0.65rem",
    background: "#27272a",
    color: "#d4d4d8",
    border: "1px solid #3f3f46",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: "0.75rem",
    marginRight: "0.4rem",
    marginTop: "0.4rem",
  },
  linkButton: {
    background: "none",
    border: "none",
    color: "#818cf8",
    cursor: "pointer",
    fontSize: "0.72rem",
    textDecoration: "underline",
  },
  sections: { margin: "1rem 0" },
  sectionRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.3rem 0",
    borderBottom: "1px solid #2a2a2a",
  },
  sectionHead: { fontSize: "0.82rem", fontWeight: 500 },
  addRow: { display: "grid", gap: "0.5rem", marginTop: "0.5rem" },
  history: { display: "flex", flexWrap: "wrap", gap: "0.25rem", margin: "0.4rem 0" },
  pre: {
    background: "#0d0d0d",
    border: "1px solid #333",
    borderRadius: 4,
    padding: "0.7rem",
    fontSize: "0.75rem",
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    marginTop: "0.5rem",
  },
  error: {
    background: "#2a1010",
    color: "#ff8f8f",
    border: "1px solid #5c1a1a",
    borderRadius: 4,
    padding: "0.5rem",
    marginTop: "0.75rem",
    whiteSpace: "pre-wrap",
  },
  muted: { color: "#a1a1aa", fontSize: "0.82rem", margin: "0.35rem 0" },
  deadRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.4rem 0",
    borderBottom: "1px solid #2a2a2a",
    flexWrap: "wrap",
  },
  deadId: { fontSize: "0.72rem", color: "#a78bfa" },
  footer: {
    marginTop: "1rem",
    fontSize: "0.7rem",
    color: "#52525b",
    textAlign: "center",
  },
};