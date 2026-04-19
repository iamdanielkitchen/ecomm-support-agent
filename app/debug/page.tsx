"use client";

import { useCallback, useEffect, useState } from "react";

type ToolLogEntry = { name: string; latency_ms: number; ok: boolean };

type TurnLog = {
  ts: number;
  turn: number;
  user_snippet: string;
  model_snippet: string;
  tools_called: ToolLogEntry[];
  total_latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  stop_reason: string;
};

type ToolInvocation = {
  turn_index: number;
  tool_name: string;
  input: unknown;
  output: unknown;
  latency_ms: number;
  timestamp: number;
};

type SessionResponse = {
  session_id: string;
  session_present: boolean;
  escalated: boolean;
  handoff_id: string | null;
  tool_trace: ToolInvocation[];
  turns: TurnLog[];
  handoff: unknown;
};

// Very rough cost model, purely for the interview-demo surface. CLAUDE.md
// says "rough token-cost estimate", not "accurate to the cent". Numbers
// sourced from Anthropic's public Sonnet 4.5 pricing as of the build; if
// they drift, these are wrong by a constant factor only.
const COST_PER_M_INPUT_USD = 3.0;
const COST_PER_M_OUTPUT_USD = 15.0;

function estimateCostUsd(tokens_in: number, tokens_out: number): number {
  return (
    (tokens_in / 1_000_000) * COST_PER_M_INPUT_USD +
    (tokens_out / 1_000_000) * COST_PER_M_OUTPUT_USD
  );
}

export default function DebugPage() {
  const [sessionId, setSessionId] = useState<string>("");
  const [data, setData] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get("session") ?? "";
    setSessionId(fromQuery);
  }, []);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/session/${encodeURIComponent(sessionId)}`);
      if (!resp.ok) throw new Error(`load_failed_${resp.status}`);
      const json = (await resp.json()) as SessionResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (sessionId) load();
  }, [sessionId, load]);

  useEffect(() => {
    if (!autoRefresh || !sessionId) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [autoRefresh, sessionId, load]);

  const invocationsByTurn = groupInvocationsByTurn(data?.tool_trace ?? []);
  const cumLatency = cumulative(data?.turns ?? []);
  const totalCost = (data?.turns ?? []).reduce(
    (acc, t) => acc + estimateCostUsd(t.tokens_in, t.tokens_out),
    0
  );

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <div style={styles.brand}>Debug · Session Trace</div>
          <div style={styles.sub}>
            {sessionId || <em style={{ color: "#6b6b75" }}>no session id</em>}
          </div>
        </div>
        <div style={styles.headerRight}>
          <label style={styles.autoLabel}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            auto-refresh
          </label>
          <button style={styles.btn} onClick={load} disabled={loading}>
            {loading ? "…" : "refresh"}
          </button>
        </div>
      </header>

      {!sessionId && (
        <div style={styles.empty}>
          Add <code>?session=&lt;uuid&gt;</code> to the URL, or follow the
          debug link from the chat page.
        </div>
      )}

      {error && <div style={styles.error}>Error: {error}</div>}

      {data && (
        <div style={styles.content}>
          <section style={styles.card}>
            <div style={styles.cardTitle}>Summary</div>
            <div style={styles.summaryGrid}>
              <SummaryCell label="turns" value={data.turns.length} />
              <SummaryCell label="tool calls" value={data.tool_trace.length} />
              <SummaryCell
                label="total latency"
                value={`${data.turns.reduce(
                  (a, t) => a + t.total_latency_ms,
                  0
                )} ms`}
              />
              <SummaryCell
                label="est. cost"
                value={`$${totalCost.toFixed(4)}`}
              />
              <SummaryCell
                label="escalated"
                value={data.escalated ? "yes" : "no"}
              />
              <SummaryCell
                label="session in memory"
                value={data.session_present ? "yes" : "no"}
              />
            </div>
          </section>

          {data.handoff && (
            <section style={{ ...styles.card, ...styles.handoffCard }}>
              <div style={styles.cardTitle}>Handoff payload</div>
              <pre style={styles.pre}>{JSON.stringify(data.handoff, null, 2)}</pre>
            </section>
          )}

          <section style={styles.card}>
            <div style={styles.cardTitle}>Turn timeline</div>
            {data.turns.length === 0 ? (
              <div style={styles.emptyInline}>No turns yet.</div>
            ) : (
              data.turns.map((t, idx) => (
                <TurnRow
                  key={t.ts + ":" + idx}
                  turn={t}
                  cumulative={cumLatency[idx] ?? 0}
                  invocations={invocationsByTurn.get(t.turn) ?? []}
                />
              ))
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function groupInvocationsByTurn(
  list: ToolInvocation[]
): Map<number, ToolInvocation[]> {
  const byTurn = new Map<number, ToolInvocation[]>();
  for (const inv of list) {
    const arr = byTurn.get(inv.turn_index) ?? [];
    arr.push(inv);
    byTurn.set(inv.turn_index, arr);
  }
  return byTurn;
}

function cumulative(turns: TurnLog[]): number[] {
  let acc = 0;
  return turns.map((t) => (acc += t.total_latency_ms));
}

function TurnRow({
  turn,
  cumulative,
  invocations,
}: {
  turn: TurnLog;
  cumulative: number;
  invocations: ToolInvocation[];
}) {
  const [open, setOpen] = useState(true);
  const cost = estimateCostUsd(turn.tokens_in, turn.tokens_out);
  return (
    <div style={styles.turn}>
      <button
        style={styles.turnHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span style={styles.turnIdx}>#{turn.turn}</span>
        <span style={styles.turnSnippet}>
          <strong>user:</strong> {turn.user_snippet || <em>·</em>}
        </span>
        <span style={styles.turnMeta}>
          {turn.total_latency_ms}ms · cum {cumulative}ms ·{" "}
          {turn.tokens_in}→{turn.tokens_out} tok · ${cost.toFixed(4)} ·{" "}
          {turn.stop_reason || "?"}
        </span>
        <span>{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div style={styles.turnBody}>
          <div style={styles.kvRow}>
            <div style={styles.kvLabel}>model</div>
            <div style={styles.kvValue}>{turn.model_snippet || <em>·</em>}</div>
          </div>
          {invocations.length > 0 && (
            <div style={styles.invocations}>
              {invocations.map((inv, i) => (
                <InvocationRow key={i} inv={inv} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InvocationRow({ inv }: { inv: ToolInvocation }) {
  const [open, setOpen] = useState(false);
  const output = inv.output as { error?: string } | null;
  const ok = !output || !("error" in (output ?? {}));
  return (
    <div style={styles.inv}>
      <button
        style={styles.invHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{ok ? "✓" : "✗"}</span>
        <code>{inv.tool_name}</code>
        <span style={{ color: "#6b6b75", marginLeft: "auto" }}>
          {inv.latency_ms}ms
        </span>
        <span style={{ color: "#6b6b75", marginLeft: 8 }}>
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <div style={styles.invBody}>
          <div style={styles.kvLabel}>input</div>
          <pre style={styles.pre}>{JSON.stringify(inv.input, null, 2)}</pre>
          <div style={styles.kvLabel}>output</div>
          <pre style={styles.pre}>{JSON.stringify(inv.output, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: unknown }) {
  return (
    <div style={styles.summaryCell}>
      <div style={styles.summaryLabel}>{label}</div>
      <div style={styles.summaryValue}>{String(value)}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { maxWidth: 960, margin: "0 auto", padding: "16px 20px" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderBottom: "1px solid #23232a",
    paddingBottom: 12,
    marginBottom: 16,
  },
  brand: { fontWeight: 600, fontSize: 16 },
  sub: { fontSize: 12, color: "#8a8a94", marginTop: 2, fontFamily: "ui-monospace, Menlo, monospace" },
  headerRight: { display: "flex", alignItems: "center", gap: 12 },
  autoLabel: { fontSize: 12, color: "#8a8a94", display: "flex", gap: 6 },
  btn: {
    padding: "6px 12px",
    background: "transparent",
    color: "#e9e9ee",
    border: "1px solid #32323a",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 12,
  },
  empty: { color: "#6b6b75", fontSize: 13, padding: "24px 0" },
  emptyInline: { color: "#6b6b75", fontSize: 13 },
  error: {
    padding: 10,
    background: "#3b1a1a",
    color: "#ffb3b3",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 12,
  },
  content: { display: "flex", flexDirection: "column", gap: 16 },
  card: {
    border: "1px solid #23232a",
    borderRadius: 8,
    padding: 16,
    background: "#101017",
  },
  handoffCard: { borderColor: "#5a4418", background: "#2b1f08" },
  cardTitle: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: "#8a8a94",
    marginBottom: 10,
  },
  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 10,
  },
  summaryCell: {
    padding: 10,
    background: "#0a0a10",
    border: "1px solid #1a1a21",
    borderRadius: 6,
  },
  summaryLabel: { fontSize: 10, color: "#6b6b75", textTransform: "uppercase" },
  summaryValue: { fontSize: 15, marginTop: 2 },
  turn: { border: "1px solid #1f1f27", borderRadius: 6, marginBottom: 8 },
  turnHeader: {
    width: "100%",
    display: "flex",
    gap: 10,
    alignItems: "center",
    padding: "8px 10px",
    background: "transparent",
    color: "#e9e9ee",
    border: "none",
    cursor: "pointer",
    fontSize: 13,
    textAlign: "left",
  },
  turnIdx: { color: "#6b6b75", minWidth: 24 },
  turnSnippet: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  turnMeta: { fontSize: 11, color: "#6b6b75" },
  turnBody: { padding: "8px 10px 12px", borderTop: "1px solid #1f1f27" },
  kvRow: { display: "flex", gap: 12, marginBottom: 8 },
  kvLabel: {
    fontSize: 10,
    color: "#6b6b75",
    textTransform: "uppercase",
    marginTop: 4,
  },
  kvValue: { flex: 1, fontSize: 13, color: "#cfcfd4" },
  invocations: { display: "flex", flexDirection: "column", gap: 6 },
  inv: { border: "1px solid #1f1f27", borderRadius: 6, background: "#0a0a10" },
  invHeader: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: "transparent",
    color: "#cfcfd4",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left",
  },
  invBody: { padding: "6px 10px 10px", borderTop: "1px solid #1f1f27" },
  pre: {
    fontSize: 12,
    margin: "4px 0 0",
    padding: 8,
    background: "#07070a",
    borderRadius: 6,
    overflowX: "auto",
  },
};
