import { createAgentStream } from "@/lib/agent";
import { getOrCreateSession } from "@/lib/sessions";

export const runtime = "nodejs"; // SDK uses node fs + process.env; no Edge

type ChatRequest = {
  session_id?: string;
  message?: string;
};

export async function POST(req: Request): Promise<Response> {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const session_id = body.session_id?.trim();
  const message = body.message?.trim();

  if (!session_id || !message) {
    return Response.json(
      { error: "missing_fields", detail: "session_id and message are required" },
      { status: 400 }
    );
  }
  if (message.length > 4000) {
    return Response.json({ error: "message_too_long" }, { status: 413 });
  }

  const session = getOrCreateSession(session_id);
  if (session.escalated) {
    return Response.json(
      { error: "session_terminal", handoff_id: session.handoff_id },
      { status: 409 }
    );
  }

  const stream = createAgentStream(session, message);

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
