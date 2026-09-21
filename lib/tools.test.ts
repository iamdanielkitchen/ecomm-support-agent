import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { __clearAllSessions, getOrCreateSession } from "./sessions";
import { findOrder, getStore, reloadStore } from "./store";
import { runTool, type ToolContext } from "./tools";

beforeEach(() => {
  __clearAllSessions();
  reloadStore();
});

function context(sessionId = "customer-a"): ToolContext {
  const session = getOrCreateSession(sessionId);
  return {
    session_id: session.session_id,
    transcript: session.messages,
    verified_orders: session.verified_orders,
    // Exercise the fixture's in-window cases regardless of the wall clock.
    now: () => new Date("2026-04-18T12:00:00Z"),
  };
}

async function assertReturnToolsDenied(ctx: ToolContext, order = "FG-100001") {
  const before = structuredClone(getStore());
  for (const name of ["check_return_eligibility", "initiate_return"]) {
    const result = await runTool(name, {
      order_number: order,
      item_sku: "FG-KIT-002",
      reason: "changed_mind",
      // Model-supplied claims must not substitute for server-owned state.
      customer_email: "maya.ortiz@example.com",
      verified_orders: [order],
    }, ctx);
    assert.equal(result.ok, false, `${name} must reject unverified orders`);
    if (!result.ok) assert.match(result.error, /^identity_verification_required:/);
  }
  assert.deepEqual(getStore(), before, "denied calls must not mutate the store");
}

test("both return tools reject direct calls without exposing order eligibility", async () => {
  const ctx = context();
  await assertReturnToolsDenied(ctx);
  // An unknown order must produce the same denial, not an existence signal.
  await assertReturnToolsDenied(ctx, "FG-999999");
});

test("mismatched and missing lookups grant nothing; a corrected lookup can recover", async () => {
  const ctx = context();
  assert.deepEqual(await runTool("lookup_order", {
    order_number: "FG-100001", customer_email: "wrong@example.com",
  }, ctx), { ok: true, value: { error: "identity_mismatch" } });
  assert.deepEqual(await runTool("lookup_order", {
    order_number: "FG-999999", customer_email: "maya.ortiz@example.com",
  }, ctx), { ok: true, value: null });
  assert.equal(ctx.verified_orders.size, 0);
  await assertReturnToolsDenied(ctx);

  await runTool("lookup_order", {
    order_number: "FG-100001", customer_email: "MAYA.ORTIZ@EXAMPLE.COM",
  }, ctx);
  assert.deepEqual(await runTool("check_return_eligibility", {
    order_number: "FG-100001", item_sku: "FG-KIT-002",
  }, ctx), { ok: true, value: { eligible: true, reason: "in_window_unopened" } });
});

test("verification is scoped to the exact order and session", async () => {
  const ctx = context();
  await runTool("lookup_order", {
    order_number: "FG-100001", customer_email: "maya.ortiz@example.com",
  }, ctx);
  await assertReturnToolsDenied(context("customer-b"));
  await assertReturnToolsDenied(ctx, "FG-100002");
  // Even another order belonging to the same customer needs its own lookup.
  await assertReturnToolsDenied(ctx, "FG-100011");
});

test("a failed re-check revokes only that order's prior verification", async () => {
  const ctx = context();
  for (const order of ["FG-100001", "FG-100011"]) {
    await runTool("lookup_order", {
      order_number: order, customer_email: "maya.ortiz@example.com",
    }, ctx);
  }
  await runTool("lookup_order", {
    order_number: "FG-100001", customer_email: "wrong@example.com",
  }, ctx);
  await assertReturnToolsDenied(ctx);
  assert.deepEqual([...ctx.verified_orders], ["FG-100011"]);
});

test("verified multi-turn return retains fee and duplicate-return safeguards", async () => {
  await runTool("lookup_order", {
    order_number: "FG-100002", customer_email: "devin.park@example.com",
  }, context());
  const input = {
    order_number: "FG-100002", item_sku: "FG-KIT-001", reason: "quality_issue",
  };
  // New contexts, as in separate model iterations and customer turns.
  assert.deepEqual(await runTool("check_return_eligibility", input, context()), {
    ok: true,
    value: { eligible: true, reason: "in_window_opened_fee", fee_usd: 7.95 },
  });
  const result = await runTool("initiate_return", input, context());
  const record = getStore().returns[0];
  assert.ok(record);
  assert.match(record.rma, /^RMA-2026-04-18-[A-Z0-9]{4}$/);
  assert.equal(record.order_number, "FG-100002");
  assert.equal(record.item_sku, "FG-KIT-001");
  assert.equal(record.fee_usd, 7.95);
  assert.equal(findOrder("FG-100002")?.items[0]?.returned, true);
  assert.deepEqual(result, {
    ok: true,
    value: {
      rma: record.rma,
      label_url: `https://fieldstone.example/labels/${record.rma}.pdf`,
      fee_usd: 7.95,
    },
  });
  assert.deepEqual(await runTool("initiate_return", input, context()), {
    ok: true, value: { error: "not_eligible", reason: "already_returned" },
  });
  assert.equal(getStore().returns.length, 1);
});

test("verification does not bypass eligibility and disappears with the session", async () => {
  await runTool("lookup_order", {
    order_number: "FG-100003", customer_email: "priya.kapoor@example.com",
  }, context());
  assert.deepEqual(await runTool("initiate_return", {
    order_number: "FG-100003", item_sku: "FG-HOM-002", reason: "changed_mind",
  }, context()), { ok: true, value: { error: "not_eligible", reason: "outside_window" } });
  assert.equal(getStore().returns.length, 0);
  __clearAllSessions();
  await assertReturnToolsDenied(context(), "FG-100003");
});
