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

type SearchChunkRef = {
  chunk_id: string;
  score: number;
  title: string;
  section_heading: string | null;
};

type SearchHelpCenterOutput = {
  content: string;
  chunks: SearchChunkRef[];
  request_id: string;
  above_threshold: boolean;
  query_tokens?: number;
  query_embedding_ms?: number;
  cosine_ms?: number;
  total_latency_ms?: number;
};

type TurnConfidence = {
  self_score: number | null;
  self_reason: string | null;
  retrieval_score: number | null;
  retrieval_top1: number | null;
  retrieval_gap: number | null;
  used_retrieval: boolean;
};

type TurnConfidenceRecord = {
  turn_index: number;
  timestamp: number;
  confidence: TurnConfidence;
};

type HandoffPayload = {
  handoff_id: string;
  session_id: string;
  reason_code: string;
  summary: string;
  priority: "standard" | "high";
  created_at: string;
  transcript: unknown;
};

type HandoffField = HandoffPayload | { error: string } | null;

type SessionResponse = {
  session_id: string;
  session_present: boolean;
  escalated: boolean;
  handoff_id: string | null;
  tool_trace: ToolInvocation[];
  confidence_per_turn: TurnConfidenceRecord[];
  turns: TurnLog[];
  handoff: HandoffField;
};

// Cost model. Agent path uses Sonnet 4.5 rates; retrieval uses voyage-4-lite
// rates. These are rough — the page is for tuning, not invoicing.
const SONNET_IN_PER_M_USD = 3.0;
const SONNET_OUT_PER_M_USD = 15.0;
const VOYAGE_LITE_PER_M_USD = 0.02;
const RETRIEVAL_THRESHOLD = 0.4;

function agentCostUsd(tokens_in: number, tokens_out: number): number {
  return (
    (tokens_in / 1_000_000) * SONNET_IN_PER_M_USD +
    (tokens_out / 1_000_000) * SONNET_OUT_PER_M_USD
  );
}

function embedCostUsd(tokens: number): number {
  return (tokens / 1_000_000) * VOYAGE_LITE_PER_M_USD;
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
  const confidenceByTurn = groupConfidenceByTurn(data?.confidence_per_turn ?? []);
  const cumLatency = cumulative(data?.turns ?? []);

  // Aggregate cost: agent per-turn + sum of embed tokens across retrieval
  // tool calls. Self-scorer cost not tracked in session.
  const agentTotalCost = (data?.turns ?? []).reduce(
    (acc, t) => acc + agentCostUsd(t.tokens_in, t.tokens_out),
    0
  );
  const embedTotalTokens = (data?.tool_trace ?? []).reduce((acc, inv) => {
    if (inv.tool_name !== "search_help_center") return acc;
    const out = inv.output as SearchHelpCenterOutput | null;
    return acc + (out?.query_tokens ?? 0);
  }, 0);
  const totalCost = agentTotalCost + embedCostUsd(embedTotalTokens);

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
            <div style={styles.cardTitle}>Session summary</div>
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
                label="agent cost"
                value={`$${agentTotalCost.toFixed(4)}`}
              />
              <SummaryCell
                label="embed tokens"
                value={embedTotalTokens.toLocaleString()}
              />
              <SummaryCell
                label="est. total cost"
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
                  confidence={confidenceByTurn.get(t.turn) ?? null}
                  openByDefault={idx === data.turns.length - 1}
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

function groupConfidenceByTurn(
  list: TurnConfidenceRecord[]
): Map<number, TurnConfidence> {
  const byTurn = new Map<number, TurnConfidence>();
  for (const r of list) byTurn.set(r.turn_index, r.confidence);
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
  confidence,
  openByDefault,
}: {
  turn: TurnLog;
  cumulative: number;
  invocations: ToolInvocation[];
  confidence: TurnConfidence | null;
  openByDefault: boolean;
}) {
  const [open, setOpen] = useState(openByDefault);
  const searchInvocations = invocations.filter(
    (i) => i.tool_name === "search_help_center"
  );
  const otherInvocations = invocations.filter(
    (i) => i.tool_name !== "search_help_center"
  );
  const agentCost = agentCostUsd(turn.tokens_in, turn.tokens_out);
  const embedTokens = searchInvocations.reduce((acc, inv) => {
    const out = inv.output as SearchHelpCenterOutput | null;
    return acc + (out?.query_tokens ?? 0);
  }, 0);
  const turnEmbedCost = embedCostUsd(embedTokens);
  const turnTotalCost = agentCost + turnEmbedCost;

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
          {turn.tokens_in}→{turn.tokens_out} tok · ${turnTotalCost.toFixed(4)} ·{" "}
          {turn.stop_reason || "?"}
        </span>
        <span>{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div style={styles.turnBody}>
          <ConfidencePanel confidence={confidence} />

          {searchInvocations.map((inv, i) => (
            <RetrievalLineagePanel key={"r" + i} inv={inv} />
          ))}

          {invocations.length > 0 && (
            <CollapsibleSection
              label={`tool calls (${invocations.length})`}
              defaultOpen={false}
            >
              <div style={styles.invocations}>
                {otherInvocations.map((inv, i) => (
                  <InvocationRow key={"o" + i} inv={inv} />
                ))}
                {searchInvocations.map((inv, i) => (
                  <SearchInvocationSummary key={"s" + i} inv={inv} />
                ))}
              </div>
            </CollapsibleSection>
          )}

          <CollapsibleSection label="model reply" defaultOpen={false}>
            <div style={styles.replyText}>{turn.model_snippet || <em>·</em>}</div>
          </CollapsibleSection>

          <CostLatencyBreakdown
            turn={turn}
            agentCost={agentCost}
            embedTokens={embedTokens}
            embedCost={turnEmbedCost}
            searchInvocations={searchInvocations}
          />
        </div>
      )}
    </div>
  );
}

function ConfidencePanel({ confidence }: { confidence: TurnConfidence | null }) {
  if (!confidence) {
    return (
      <div style={styles.confPanel}>
        <div style={styles.confTitle}>Confidence</div>
        <div style={styles.emptyInline}>not yet scored (in-flight)</div>
      </div>
    );
  }

  const { self_score, retrieval_score, used_retrieval } = confidence;

  // Surface disagreement visually — the whole point of dual-signal
  // instrumentation. If both scores exist and differ by more than 0.3,
  // highlight the panel with an amber border so recruiters can't miss it.
  const bothPresent = self_score !== null && retrieval_score !== null;
  const divergent =
    bothPresent &&
    Math.abs((self_score ?? 0) - (retrieval_score ?? 0)) > 0.3;

  return (
    <div
      style={{
        ...styles.confPanel,
        ...(divergent ? styles.confPanelDivergent : {}),
      }}
    >
      <div style={styles.confTitleRow}>
        <div style={styles.confTitle}>
          Confidence {divergent && <span style={styles.divergeTag}>· signals disagree</span>}
        </div>
        <div style={styles.confHint}>
          self-scoring without retrieval context · retrieval-derived from top-1 cosine
        </div>
      </div>
      <div style={styles.confGrid}>
        <ConfCard
          title="Self-score"
          scoreLabel="Haiku"
          score={self_score}
          subtitle={confidence.self_reason ?? "—"}
        />
        <ConfCard
          title="Retrieval"
          scoreLabel={used_retrieval ? "voyage-4-lite" : "not used"}
          score={retrieval_score}
          subtitle={
            used_retrieval
              ? `top1 ${fmtScore(confidence.retrieval_top1)} · gap-to-top2 ${fmtScore(
                  confidence.retrieval_gap
                )}`
              : "no search_help_center call this turn"
          }
        />
      </div>
    </div>
  );
}

function ConfCard({
  title,
  scoreLabel,
  score,
  subtitle,
}: {
  title: string;
  scoreLabel: string;
  score: number | null;
  subtitle: string;
}) {
  const band = scoreBand(score);
  return (
    <div style={{ ...styles.confCard, borderColor: band.border }}>
      <div style={styles.confCardTop}>
        <div style={styles.confCardLabel}>{title}</div>
        <div style={styles.confCardSublabel}>{scoreLabel}</div>
      </div>
      <div style={{ ...styles.confScore, color: band.text }}>
        {score === null ? "—" : score.toFixed(2)}
      </div>
      <div style={styles.confCardSubtitle}>{subtitle}</div>
    </div>
  );
}

function scoreBand(score: number | null): { border: string; text: string } {
  if (score === null) return { border: "#2a2a32", text: "#6b6b75" };
  if (score >= 0.7) return { border: "#2d5a3e", text: "#7fd19a" };
  if (score >= 0.4) return { border: "#5a4418", text: "#f0c674" };
  return { border: "#5a2020", text: "#e28787" };
}

function fmtScore(n: number | null): string {
  return n === null ? "null" : n.toFixed(3);
}

function RetrievalLineagePanel({ inv }: { inv: ToolInvocation }) {
  const [open, setOpen] = useState(false);
  const out = inv.output as SearchHelpCenterOutput | { error: string } | null;
  const isError = out && typeof out === "object" && "error" in out;
  const good = !isError && out !== null;
  const search = good ? (out as SearchHelpCenterOutput) : null;
  const input = inv.input as { query?: string } | null;
  const chunks = search?.chunks ?? [];
  const chunkBodies = search ? splitContentByChunk(search.content, chunks.length) : [];
  const above = search?.above_threshold ?? false;
  const top1 = chunks[0]?.score ?? null;

  return (
    <div
      style={{
        ...styles.retrPanel,
        borderColor: isError ? "#5a2020" : above ? "#23332a" : "#5a4418",
      }}
    >
      <button
        style={styles.retrHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span style={styles.retrKind}>retrieval</span>
        <span style={styles.retrQuery}>
          {input?.query ? `"${input.query}"` : <em>no query</em>}
        </span>
        <span style={styles.retrVerdict}>
          {isError
            ? "ERROR"
            : above
              ? `PASS · top1 ${fmtScore(top1)}`
              : `FILTERED · top1 ${fmtScore(top1)} < ${RETRIEVAL_THRESHOLD}`}
        </span>
        <span style={styles.retrToggle}>{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div style={styles.retrBody}>
          {isError && (
            <div style={styles.retrError}>
              <div style={styles.kvLabel}>tool error</div>
              <pre style={styles.pre}>{(out as { error: string }).error}</pre>
            </div>
          )}

          {good && search && (
            <>
              <div style={styles.retrTiming}>
                embed {search.query_embedding_ms ?? "?"}ms · cosine{" "}
                {search.cosine_ms ?? "?"}ms · total{" "}
                {search.total_latency_ms ?? inv.latency_ms}ms ·{" "}
                {search.query_tokens ?? "?"} query tokens
              </div>

              {chunks.length === 0 ? (
                <div style={styles.retrNoChunks}>
                  NO_RELEVANT_CONTENT — top-1 below 0.40 threshold, agent
                  returned the sentinel.
                </div>
              ) : (
                <div style={styles.chunkList}>
                  {chunks.map((c, i) => (
                    <ChunkRow
                      key={c.chunk_id}
                      chunk={c}
                      body={chunkBodies[i] ?? ""}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ChunkRow({
  chunk,
  body,
}: {
  chunk: SearchChunkRef;
  body: string;
}) {
  const slug = chunk.chunk_id.split("#")[0] ?? chunk.chunk_id;
  return (
    <div style={styles.chunk}>
      <div style={styles.chunkHeader}>
        <span style={styles.chunkScore}>{chunk.score.toFixed(3)}</span>
        <code style={styles.chunkId}>{chunk.chunk_id}</code>
        <span style={styles.chunkTitle}>
          {chunk.title}
          {chunk.section_heading ? ` · ${chunk.section_heading}` : ""}
        </span>
        <span style={styles.chunkSlug}>slug: {slug}</span>
      </div>
      <div style={styles.chunkBody}>{body || <em>(body unavailable)</em>}</div>
    </div>
  );
}

// search_help_center's `content` field joins top-k chunks with "\n---\n".
// Each entry starts "## {title} — {heading}" then the body. We split on the
// delimiter and then strip the leading header line so we render body-only
// here — the header metadata already shows in ChunkRow.
function splitContentByChunk(content: string, expectedCount: number): string[] {
  const parts = content.split(/\n---\n/);
  const bodies = parts.map((p) => {
    // Strip the first line if it's a "## …" header.
    const firstNl = p.indexOf("\n");
    if (firstNl === -1) return p.trim();
    const first = p.slice(0, firstNl);
    if (first.startsWith("##")) return p.slice(firstNl + 1).trim();
    return p.trim();
  });
  // If something upstream changed the join format, fall back to raw content.
  if (bodies.length !== expectedCount) return bodies;
  return bodies;
}

function SearchInvocationSummary({ inv }: { inv: ToolInvocation }) {
  const out = inv.output as SearchHelpCenterOutput | { error: string } | null;
  const isError = out && typeof out === "object" && "error" in out;
  const chunkCount =
    !isError && out ? (out as SearchHelpCenterOutput).chunks?.length ?? 0 : 0;
  return (
    <div style={styles.inv}>
      <div style={{ ...styles.invHeader, cursor: "default" }}>
        <span>{isError ? "✗" : "✓"}</span>
        <code>search_help_center</code>
        <span style={{ color: "#6b6b75" }}>→ {chunkCount} chunks</span>
        <span style={{ color: "#6b6b75", marginLeft: "auto" }}>
          {inv.latency_ms}ms
        </span>
      </div>
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

function CostLatencyBreakdown({
  turn,
  agentCost,
  embedTokens,
  embedCost,
  searchInvocations,
}: {
  turn: TurnLog;
  agentCost: number;
  embedTokens: number;
  embedCost: number;
  searchInvocations: ToolInvocation[];
}) {
  const retrievalLatency = searchInvocations.reduce(
    (acc, inv) => acc + inv.latency_ms,
    0
  );
  return (
    <div style={styles.costBox}>
      <div style={styles.cardTitle}>Cost · latency</div>
      <div style={styles.costGrid}>
        <CostCell
          label="agent"
          line1={`${turn.tokens_in} in · ${turn.tokens_out} out`}
          line2={`$${agentCost.toFixed(5)}`}
        />
        <CostCell
          label="retrieval"
          line1={`${embedTokens} query tokens · ${retrievalLatency}ms`}
          line2={`$${embedCost.toFixed(5)}`}
        />
        <CostCell
          label="turn total"
          line1={`${turn.total_latency_ms}ms end-to-end`}
          line2={`$${(agentCost + embedCost).toFixed(5)}`}
          emphasize
        />
      </div>
    </div>
  );
}

function CostCell({
  label,
  line1,
  line2,
  emphasize,
}: {
  label: string;
  line1: string;
  line2: string;
  emphasize?: boolean;
}) {
  return (
    <div
      style={{
        ...styles.costCell,
        ...(emphasize ? styles.costCellEmph : {}),
      }}
    >
      <div style={styles.costLabel}>{label}</div>
      <div style={styles.costLine1}>{line1}</div>
      <div style={styles.costLine2}>{line2}</div>
    </div>
  );
}

function CollapsibleSection({
  label,
  defaultOpen,
  children,
}: {
  label: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={styles.section}>
      <button
        style={styles.sectionHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{label}</span>
        <span style={{ color: "#6b6b75", marginLeft: "auto" }}>
          {open ? "−" : "+"}
        </span>
      </button>
      {open && <div style={styles.sectionBody}>{children}</div>}
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
  main: { maxWidth: 1080, margin: "0 auto", padding: "16px 20px" },
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
  turn: { border: "1px solid #1f1f27", borderRadius: 6, marginBottom: 12 },
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
  turnBody: {
    padding: "10px 10px 12px",
    borderTop: "1px solid #1f1f27",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },

  // confidence panel — the hero section
  confPanel: {
    border: "1px solid #23232a",
    borderRadius: 8,
    padding: 12,
    background: "#0c0c14",
  },
  confPanelDivergent: {
    borderColor: "#8a6a14",
    background: "#1a140a",
  },
  confTitleRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 10,
  },
  confTitle: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: "#cfcfd4",
    fontWeight: 600,
  },
  divergeTag: {
    color: "#f0c674",
    fontWeight: 500,
    textTransform: "none",
    letterSpacing: 0,
    marginLeft: 6,
  },
  confHint: { fontSize: 10, color: "#6b6b75", fontStyle: "italic" },
  confGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  confCard: {
    padding: "10px 12px",
    background: "#0a0a10",
    border: "1px solid #2a2a32",
    borderRadius: 6,
  },
  confCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  confCardLabel: {
    fontSize: 11,
    color: "#cfcfd4",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  confCardSublabel: { fontSize: 10, color: "#6b6b75", fontFamily: "ui-monospace, Menlo, monospace" },
  confScore: { fontSize: 28, fontWeight: 600, fontVariantNumeric: "tabular-nums", lineHeight: 1 },
  confCardSubtitle: { fontSize: 11, color: "#8a8a94", marginTop: 6, lineHeight: 1.4 },

  // retrieval lineage
  retrPanel: { border: "1px solid #23332a", borderRadius: 8, background: "#0a120c" },
  retrHeader: {
    width: "100%",
    display: "flex",
    gap: 10,
    alignItems: "center",
    padding: "8px 12px",
    background: "transparent",
    color: "#cfcfd4",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left",
  },
  retrKind: {
    fontSize: 10,
    color: "#6b6b75",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  retrQuery: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontStyle: "italic",
    color: "#cfcfd4",
  },
  retrVerdict: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 11,
    color: "#8a8a94",
  },
  retrToggle: { color: "#6b6b75", minWidth: 14, textAlign: "right" },
  retrBody: { padding: "10px 12px 12px", borderTop: "1px solid #1a2a1f" },
  retrTiming: {
    fontSize: 11,
    color: "#8a8a94",
    marginBottom: 10,
    fontFamily: "ui-monospace, Menlo, monospace",
  },
  retrNoChunks: {
    fontSize: 12,
    color: "#f0c674",
    padding: 8,
    background: "#1a140a",
    borderRadius: 6,
    fontFamily: "ui-monospace, Menlo, monospace",
  },
  retrError: { marginBottom: 10 },
  chunkList: { display: "flex", flexDirection: "column", gap: 8 },
  chunk: {
    border: "1px solid #1a2a1f",
    borderRadius: 6,
    background: "#07100a",
  },
  chunkHeader: {
    display: "flex",
    gap: 10,
    alignItems: "baseline",
    padding: "6px 10px",
    borderBottom: "1px solid #1a2a1f",
    flexWrap: "wrap",
  },
  chunkScore: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 12,
    color: "#7fd19a",
    minWidth: 46,
  },
  chunkId: {
    fontSize: 11,
    color: "#cfcfd4",
    fontFamily: "ui-monospace, Menlo, monospace",
  },
  chunkTitle: { fontSize: 12, color: "#cfcfd4", flex: 1 },
  chunkSlug: { fontSize: 10, color: "#6b6b75", fontFamily: "ui-monospace, Menlo, monospace" },
  chunkBody: {
    padding: "8px 10px",
    fontSize: 12,
    color: "#a8a8b0",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },

  // collapsible sections (tools, reply, cost)
  section: { border: "1px solid #23232a", borderRadius: 6, background: "#0a0a10" },
  sectionHeader: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    padding: "8px 10px",
    background: "transparent",
    color: "#cfcfd4",
    border: "none",
    cursor: "pointer",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    textAlign: "left",
  },
  sectionBody: { padding: "8px 10px 10px", borderTop: "1px solid #1f1f27" },

  // reply text
  replyText: {
    fontSize: 13,
    color: "#cfcfd4",
    whiteSpace: "pre-wrap",
    lineHeight: 1.5,
  },

  // cost/latency breakdown
  costBox: {
    border: "1px solid #23232a",
    borderRadius: 6,
    padding: 10,
    background: "#0a0a10",
  },
  costGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 8,
  },
  costCell: {
    padding: 8,
    background: "#07070a",
    border: "1px solid #1a1a21",
    borderRadius: 6,
  },
  costCellEmph: { borderColor: "#2a3a2e", background: "#0a130e" },
  costLabel: {
    fontSize: 10,
    color: "#6b6b75",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  costLine1: { fontSize: 11, color: "#a8a8b0", marginTop: 3 },
  costLine2: {
    fontSize: 13,
    color: "#cfcfd4",
    marginTop: 3,
    fontVariantNumeric: "tabular-nums",
  },

  // tool invocations (non-search)
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
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },

  // legacy kv label (still used in a couple places)
  kvLabel: {
    fontSize: 10,
    color: "#6b6b75",
    textTransform: "uppercase",
    marginTop: 4,
  },
};
