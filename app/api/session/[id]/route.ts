import { readTurns } from "@/lib/logger";
import { getSession } from "@/lib/sessions";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const runtime = "nodejs";

type Ctx = { params: { id: string } };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const id = ctx.params.id;
  if (!id) return Response.json({ error: "missing_id" }, { status: 400 });

  const session = getSession(id);
  const turns = readTurns(id);

  let handoff: unknown = null;
  const handoffPath = join(process.cwd(), "logs", "handoffs", `${id}.json`);
  if (existsSync(handoffPath)) {
    try {
      handoff = JSON.parse(readFileSync(handoffPath, "utf-8"));
    } catch {
      handoff = { error: "unreadable_handoff_file" };
    }
  }

  return Response.json({
    session_id: id,
    // We expose the in-memory pieces the debug view needs. The transcript
    // (session.messages) is NOT exposed here — it's available in the handoff
    // payload when escalated, and transient otherwise.
    session_present: !!session,
    escalated: session?.escalated ?? false,
    handoff_id: session?.handoff_id ?? null,
    tool_trace: session?.tool_trace ?? [],
    turns,
    handoff,
  });
}
