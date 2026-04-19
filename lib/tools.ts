import type Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findCatalogItem,
  findOrder,
  getStore,
  type Order,
  type Return,
} from "./store";

// --- Anthropic tool schemas -------------------------------------------------
// Sent to the model on every turn. Keep descriptions short: the system prompt
// already carries the behavioral rules. The schemas should describe *what the
// tool is* and *what shape the input takes*, not *when to call it*.

export const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: "lookup_order",
    description:
      "Look up an order by its order number. Verifies the customer's email matches the order before returning any details. Returns the full order record, or an error object if the email does not match, or null if no such order exists.",
    input_schema: {
      type: "object",
      properties: {
        order_number: {
          type: "string",
          pattern: "^FG-[0-9]{6}$",
          description: "Order number, format FG-123456.",
        },
        customer_email: {
          type: "string",
          format: "email",
          description: "Customer's email on file for the order.",
        },
      },
      required: ["order_number", "customer_email"],
    },
  },
  {
    name: "check_return_eligibility",
    description:
      "Check whether a specific item on a specific order is eligible for return. Returns {eligible, reason, fee_usd?}. Call before telling a customer whether something can be returned.",
    input_schema: {
      type: "object",
      properties: {
        order_number: { type: "string", pattern: "^FG-[0-9]{6}$" },
        item_sku: { type: "string" },
      },
      required: ["order_number", "item_sku"],
    },
  },
  {
    name: "initiate_return",
    description:
      "Create a return for an eligible item. Only call after check_return_eligibility returned eligible:true AND the customer has explicitly confirmed they want to proceed. Returns {rma, label_url}.",
    input_schema: {
      type: "object",
      properties: {
        order_number: { type: "string", pattern: "^FG-[0-9]{6}$" },
        item_sku: { type: "string" },
        reason: {
          type: "string",
          enum: [
            "damaged",
            "wrong_item",
            "changed_mind",
            "didnt_fit",
            "quality_issue",
            "other",
          ],
        },
        reason_note: {
          type: "string",
          maxLength: 500,
          description: "Optional free-text note, max 500 chars.",
        },
      },
      required: ["order_number", "item_sku", "reason"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand off the conversation to a human agent. Writes a handoff payload and marks the session terminal. Call immediately when a rule in the system prompt triggers escalation.",
    input_schema: {
      type: "object",
      properties: {
        reason_code: {
          type: "string",
          enum: [
            "customer_requested_human",
            "out_of_scope",
            "tool_failure",
            "emotional_distress",
            "policy_exception_request",
            "suspected_fraud_or_security",
            "ambiguous_identity",
          ],
          description:
            "Load-bearing routing signal for the contact-center platform. Pick the most specific code.",
        },
        summary: {
          type: "string",
          maxLength: 300,
          description:
            "One-paragraph summary of the situation for the human agent.",
        },
        priority: {
          type: "string",
          enum: ["standard", "high"],
          description:
            "Use 'high' for emotional distress, suspected fraud, or security.",
        },
      },
      required: ["reason_code", "summary", "priority"],
    },
  },
];

// --- Tool context passed through the dispatch ------------------------------

export type ToolContext = {
  session_id: string;
  transcript: Anthropic.MessageParam[]; // full conversation up to this point
  now: () => Date; // injectable for deterministic eval runs
  onEscalate?: (handoffId: string) => void; // session flips terminal
};

// --- Dispatcher ------------------------------------------------------------

export type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export async function runTool(
  name: string,
  input: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    switch (name) {
      case "lookup_order":
        return { ok: true, value: lookupOrder(input as LookupOrderInput) };
      case "check_return_eligibility":
        return {
          ok: true,
          value: checkReturnEligibility(input as EligibilityInput, ctx),
        };
      case "initiate_return":
        return {
          ok: true,
          value: initiateReturn(input as InitiateReturnInput, ctx),
        };
      case "escalate_to_human":
        return {
          ok: true,
          value: escalateToHuman(input as EscalateInput, ctx),
        };
      default:
        return { ok: false, error: `unknown tool: ${name}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// --- Implementations -------------------------------------------------------

type LookupOrderInput = { order_number: string; customer_email: string };

function lookupOrder(
  input: LookupOrderInput
): Order | { error: "identity_mismatch" } | null {
  const order = findOrder(input.order_number);
  if (!order) return null;
  if (
    order.customer_email.toLowerCase() !== input.customer_email.toLowerCase()
  ) {
    return { error: "identity_mismatch" };
  }
  return order;
}

type EligibilityInput = { order_number: string; item_sku: string };

type EligibilityReason =
  | "in_window_unopened"
  | "in_window_opened_fee"
  | "outside_window"
  | "final_sale"
  | "already_returned"
  | "not_yet_delivered"
  | "lost_in_transit_escalate";

type EligibilityResult = {
  eligible: boolean;
  reason: EligibilityReason | "order_not_found" | "item_not_on_order";
  fee_usd?: number;
};

const RETURN_WINDOW_DAYS = 30;
const OPENED_ITEM_FEE_USD = 7.95;

function checkReturnEligibility(
  input: EligibilityInput,
  ctx: ToolContext
): EligibilityResult {
  const order = findOrder(input.order_number);
  if (!order) return { eligible: false, reason: "order_not_found" };

  const item = order.items.find((i) => i.sku === input.item_sku);
  if (!item) return { eligible: false, reason: "item_not_on_order" };

  if (order.status === "lost_in_transit") {
    return { eligible: false, reason: "lost_in_transit_escalate" };
  }

  if (
    order.status === "placed" ||
    order.status === "in_transit" ||
    order.status === "refused_at_delivery"
  ) {
    return { eligible: false, reason: "not_yet_delivered" };
  }

  if (item.returned) {
    return { eligible: false, reason: "already_returned" };
  }

  const catalog = findCatalogItem(input.item_sku);
  if (catalog?.final_sale) {
    return { eligible: false, reason: "final_sale" };
  }

  if (!order.delivered_at) {
    // Status is "delivered" per the guard above, so delivered_at should exist.
    // Defensive default: treat as not-yet-delivered.
    return { eligible: false, reason: "not_yet_delivered" };
  }

  const deliveredAt = new Date(order.delivered_at + "T00:00:00Z");
  const now = ctx.now();
  const daysSinceDelivery =
    (now.getTime() - deliveredAt.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceDelivery > RETURN_WINDOW_DAYS) {
    return { eligible: false, reason: "outside_window" };
  }

  if (item.opened) {
    return {
      eligible: true,
      reason: "in_window_opened_fee",
      fee_usd: OPENED_ITEM_FEE_USD,
    };
  }

  return { eligible: true, reason: "in_window_unopened" };
}

type InitiateReturnInput = {
  order_number: string;
  item_sku: string;
  reason: string;
  reason_note?: string;
};

type InitiateReturnResult =
  | { rma: string; label_url: string; fee_usd: number }
  | { error: string; reason?: string };

function initiateReturn(
  input: InitiateReturnInput,
  ctx: ToolContext
): InitiateReturnResult {
  // Defense in depth: re-check eligibility. The model might have skipped it,
  // or the state might have changed.
  const eligibility = checkReturnEligibility(
    { order_number: input.order_number, item_sku: input.item_sku },
    ctx
  );
  if (!eligibility.eligible) {
    return { error: "not_eligible", reason: eligibility.reason };
  }

  const order = findOrder(input.order_number);
  if (!order) return { error: "order_not_found" };
  const item = order.items.find((i) => i.sku === input.item_sku);
  if (!item) return { error: "item_not_on_order" };

  // Mark returned in the in-memory store. Not persisted to disk.
  item.returned = true;

  const now = ctx.now();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const rma = `RMA-${yyyy}-${mm}-${dd}-${suffix}`;

  const record: Return = {
    rma,
    order_number: input.order_number,
    item_sku: input.item_sku,
    reason: input.reason,
    reason_note: input.reason_note,
    fee_usd: eligibility.fee_usd ?? 0,
    created_at: now.toISOString(),
  };
  getStore().returns.push(record);

  return {
    rma,
    label_url: `https://fieldstone.example/labels/${rma}.pdf`,
    fee_usd: eligibility.fee_usd ?? 0,
  };
}

type EscalateInput = {
  reason_code: string;
  summary: string;
  priority: "standard" | "high";
};

type EscalateResult = {
  handoff_id: string;
  priority: "standard" | "high";
  expected_response: string;
};

function escalateToHuman(
  input: EscalateInput,
  ctx: ToolContext
): EscalateResult {
  const now = ctx.now();
  const handoff_id = `HO-${now.getUTCFullYear()}${String(
    now.getUTCMonth() + 1
  ).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}-${Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase()}`;

  const payload = {
    handoff_id,
    session_id: ctx.session_id,
    reason_code: input.reason_code,
    summary: input.summary,
    priority: input.priority,
    created_at: now.toISOString(),
    transcript: ctx.transcript,
  };

  const dir = join(process.cwd(), "logs", "handoffs");
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${ctx.session_id}.json`);
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    // Swallow filesystem errors here: the session must still flip terminal
    // so the UI disables input. The logger will separately capture the
    // failure. The handoff result we return to the model stays the same.
  }

  ctx.onEscalate?.(handoff_id);

  return {
    handoff_id,
    priority: input.priority,
    expected_response:
      input.priority === "high" ? "under 15 minutes" : "under 2 hours",
  };
}

// Expose for tests / eval harness.
export const __internal = {
  lookupOrder,
  checkReturnEligibility,
  initiateReturn,
  escalateToHuman,
};
