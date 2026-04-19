"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ToolEvent = {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  ok?: boolean;
  latency_ms?: number;
  done: boolean;
};

type AssistantMessage = {
  role: "assistant";
  text: string;
  tools: ToolEvent[];
};
type UserMessage = { role: "user"; text: string };
type Message = AssistantMessage | UserMessage;

type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_started"; name: string; input: unknown; id: string }
  | {
      type: "tool_use_result";
      name: string;
      id: string;
      output: unknown;
      ok: boolean;
      latency_ms: number;
    }
  | { type: "escalated"; handoff_id: string }
  | { type: "end_turn"; stop_reason: string }
  | { type: "error"; message: string };

const SESSION_STORAGE_KEY = "fieldstone.session_id";

function getSessionId(): string {
  if (typeof window === "undefined") return "";
  let id = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  }
  return id;
}

export default function Home() {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [escalated, setEscalated] = useState<{ handoff_id: string; priority: "standard" | "high" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSessionId(getSessionId());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const resetChat = useCallback(() => {
    const newId = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, newId);
    setSessionId(newId);
    setMessages([]);
    setEscalated(null);
    setError(null);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || escalated || !sessionId) return;

    setInput("");
    setSending(true);
    setError(null);
    setMessages((prev) => [
      ...prev,
      { role: "user", text },
      { role: "assistant", text: "", tools: [] },
    ]);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message: text }),
      });

      if (!resp.ok || !resp.body) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : `request_failed_${resp.status}`
        );
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) handleEvent(JSON.parse(line) as AgentEvent);
          nl = buffer.indexOf("\n");
        }
      }
      // flush any trailing event without a newline
      if (buffer.trim()) handleEvent(JSON.parse(buffer.trim()) as AgentEvent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setSending(false);
    }

    function handleEvent(ev: AgentEvent): void {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== "assistant") return prev;
        const next = prev.slice(0, -1);
        let updated: AssistantMessage = { ...last, tools: [...last.tools] };

        switch (ev.type) {
          case "text_delta":
            updated = { ...updated, text: updated.text + ev.text };
            break;
          case "tool_use_started":
            updated.tools = [
              ...updated.tools,
              { id: ev.id, name: ev.name, input: ev.input, done: false },
            ];
            break;
          case "tool_use_result":
            updated.tools = updated.tools.map((t) =>
              t.id === ev.id
                ? {
                    ...t,
                    output: ev.output,
                    ok: ev.ok,
                    latency_ms: ev.latency_ms,
                    done: true,
                  }
                : t
            );
            break;
          case "escalated": {
            // Priority comes from the tool_use_result we just received; infer
            // from the latest escalate_to_human tool output if present.
            const latestEscalate = [...updated.tools]
              .reverse()
              .find((t) => t.name === "escalate_to_human" && t.done);
            const out = latestEscalate?.output as
              | { priority?: "standard" | "high" }
              | undefined;
            setEscalated({
              handoff_id: ev.handoff_id,
              priority: out?.priority === "high" ? "high" : "standard",
            });
            break;
          }
          case "end_turn":
            break;
          case "error":
            setError(ev.message);
            break;
        }
        return [...next, updated];
      });
    }
  }, [input, sending, escalated, sessionId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <div>
          <div style={styles.brand}>Fieldstone Support</div>
          <div style={styles.sub}>Ember, the Fieldstone Goods assistant</div>
        </div>
        <div style={styles.headerRight}>
          {sessionId && (
            <a
              href={`/debug?session=${sessionId}`}
              target="_blank"
              rel="noreferrer"
              style={styles.debugLink}
            >
              debug ↗
            </a>
          )}
          <button style={styles.resetBtn} onClick={resetChat}>
            new chat
          </button>
        </div>
      </header>

      <section style={styles.thread}>
        {messages.length === 0 && (
          <div style={styles.emptyHint}>
            Ask about an order — you'll need the order number (format{" "}
            <code>FG-100001</code>) and the email on file.
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
        {sending &&
          messages[messages.length - 1]?.role === "assistant" &&
          (messages[messages.length - 1] as AssistantMessage).text === "" && (
            <div style={styles.typing}>Ember is thinking…</div>
          )}
        <div ref={bottomRef} />
      </section>

      {escalated && (
        <div style={styles.escalationBanner}>
          Connecting you with a human agent. Ticket{" "}
          <strong>#{escalated.handoff_id}</strong>. Expected response:{" "}
          {escalated.priority === "high" ? "< 15 min" : "< 2 hours"}.
        </div>
      )}

      {error && <div style={styles.errorBanner}>Error: {error}</div>}

      <footer style={styles.footer}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            escalated
              ? "This conversation has been handed off."
              : "Type a message. Enter to send, shift+Enter for newline."
          }
          disabled={!!escalated || sending}
          style={styles.input}
          rows={2}
        />
        <button
          onClick={send}
          disabled={!input.trim() || sending || !!escalated}
          style={styles.sendBtn}
        >
          {sending ? "…" : "send"}
        </button>
      </footer>
    </main>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div style={{ ...styles.bubbleRow, justifyContent: "flex-end" }}>
        <div style={{ ...styles.bubble, ...styles.userBubble }}>
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div style={styles.bubbleRow}>
      <div style={{ ...styles.bubble, ...styles.assistantBubble }}>
        {message.tools.length > 0 && (
          <div style={styles.toolList}>
            {message.tools.map((t) => (
              <ToolPill key={t.id} tool={t} />
            ))}
          </div>
        )}
        <div style={{ whiteSpace: "pre-wrap" }}>{message.text}</div>
      </div>
    </div>
  );
}

function ToolPill({ tool }: { tool: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const statusGlyph = !tool.done ? "…" : tool.ok ? "✓" : "✗";
  return (
    <div style={styles.toolPill}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={styles.toolPillHeader}
        aria-expanded={open}
      >
        <span style={styles.toolGlyph}>{statusGlyph}</span>
        <code>{tool.name}</code>
        {tool.latency_ms !== undefined && (
          <span style={styles.toolLatency}>{tool.latency_ms}ms</span>
        )}
        <span style={styles.toolToggle}>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div style={styles.toolBody}>
          <div style={styles.toolBodyLabel}>input</div>
          <pre style={styles.toolPre}>
            {JSON.stringify(tool.input, null, 2)}
          </pre>
          {tool.done && (
            <>
              <div style={styles.toolBodyLabel}>output</div>
              <pre style={styles.toolPre}>
                {JSON.stringify(tool.output, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Inline styles — "functional not pretty" is the explicit brief. Keeping
// styling here avoids a styling-library decision I'd rather defer.
const styles: Record<string, React.CSSProperties> = {
  main: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    maxWidth: 780,
    margin: "0 auto",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 20px",
    borderBottom: "1px solid #23232a",
  },
  brand: { fontWeight: 600, fontSize: 16 },
  sub: { fontSize: 12, color: "#8a8a94", marginTop: 2 },
  headerRight: { display: "flex", gap: 12, alignItems: "center" },
  debugLink: { fontSize: 12, color: "#8a8a94", textDecoration: "none" },
  resetBtn: {
    fontSize: 12,
    padding: "6px 10px",
    background: "transparent",
    color: "#e9e9ee",
    border: "1px solid #32323a",
    borderRadius: 6,
    cursor: "pointer",
  },
  thread: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  emptyHint: {
    color: "#6b6b75",
    fontSize: 13,
    padding: "8px 0",
  },
  bubbleRow: { display: "flex" },
  bubble: {
    maxWidth: "78%",
    padding: "10px 12px",
    borderRadius: 10,
    fontSize: 14,
    lineHeight: 1.45,
  },
  userBubble: { background: "#2a5bd7", color: "#fff" },
  assistantBubble: { background: "#1a1a21", border: "1px solid #23232a" },
  typing: { color: "#6b6b75", fontSize: 13, paddingLeft: 4 },
  toolList: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 },
  toolPill: {
    border: "1px solid #2a2a32",
    borderRadius: 8,
    background: "#0f0f14",
  },
  toolPillHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "6px 10px",
    background: "transparent",
    color: "#cfcfd4",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    textAlign: "left",
  },
  toolGlyph: { width: 12, textAlign: "center" },
  toolLatency: { color: "#6b6b75", marginLeft: "auto" },
  toolToggle: { marginLeft: 8, color: "#6b6b75" },
  toolBody: { padding: "6px 10px 10px", borderTop: "1px solid #23232a" },
  toolBodyLabel: {
    fontSize: 11,
    color: "#6b6b75",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 4,
  },
  toolPre: {
    fontSize: 12,
    margin: "4px 0 0",
    padding: 8,
    background: "#07070a",
    borderRadius: 6,
    overflowX: "auto",
  },
  escalationBanner: {
    padding: "10px 16px",
    background: "#3b2e12",
    color: "#ffd98a",
    borderTop: "1px solid #5a4418",
    fontSize: 13,
  },
  errorBanner: {
    padding: "10px 16px",
    background: "#3b1a1a",
    color: "#ffb3b3",
    borderTop: "1px solid #5a2525",
    fontSize: 13,
  },
  footer: {
    display: "flex",
    gap: 8,
    padding: 12,
    borderTop: "1px solid #23232a",
  },
  input: {
    flex: 1,
    padding: 10,
    fontSize: 14,
    background: "#0f0f14",
    color: "#e9e9ee",
    border: "1px solid #23232a",
    borderRadius: 8,
    resize: "none",
    fontFamily: "inherit",
  },
  sendBtn: {
    padding: "0 16px",
    background: "#2a5bd7",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
};
