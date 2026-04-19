# Fieldstone Support Agent

Portfolio-grade conversational support agent for a fictional home-goods store
("Fieldstone Goods"). Chat UI → streaming tool-use loop → four narrow tools →
handoff payload on escalation. No agent framework; Anthropic SDK direct.

See `CLAUDE.md` for the full spec and architectural reasoning.

## Architecture (one paragraph)

A Next.js App Router app. The client keeps a per-tab `session_id` in
`sessionStorage`; the server keeps the full message history for that id in an
in-memory `Map<string, SessionState>` with a 30-minute TTL sweeper. Each user
turn posts to `/api/chat`, which streams an Anthropic `messages.stream`
response. When the model emits `tool_use`, the server runs the tool against
`data/store.json` (or writes handoff JSON for `escalate_to_human`), appends the
`tool_result` to the message array, and loops — until the model stops with
`end_turn`. Every invocation is recorded in the session's `tool_trace`; each
turn is serialized as one JSONL line under `logs/sessions/{id}.jsonl`. The
`/debug?session={id}` page reads that file and renders the timeline — that
page is the interview surface. Escalation is load-bearing: on
`escalate_to_human` we mark the session terminal, freeze the UI, and write the
payload we would hand to a contact-center platform to `logs/handoffs/{id}.json`.

## Run

```bash
pnpm install
cp .env.example .env.local    # add ANTHROPIC_API_KEY
pnpm dev                      # http://localhost:3000
pnpm eval                     # replay golden set against local /api/chat
```

## Layout

```
app/           chat UI, /debug, /api/chat, /api/session/:id
lib/           agent loop, tools, sessions, logger, prompts, anthropic client
data/          store.json (orders/catalog/customers) + golden-set.json
evals/         replay harness + rubric
logs/          per-session JSONL + per-escalation handoff payloads (gitignored)
```
