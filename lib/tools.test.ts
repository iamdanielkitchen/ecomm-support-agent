import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { __clearAllSessions, getOrCreateSession } from "./sessions";
import { getStore, reloadStore } from "./store";
import { runTool, type ToolContext } from "./tools";

// Anchor to the fixture's original date so eligible orders stay eligible.
const NOW = new Date("2026-04-18T12:00:00Z");
const ITEM = { order_number: "FG-100001", item_sku: "FG-KIT-002" };
const LOOKUP = {
  order_number: ITEM.order_number,
  customer_email: "maya.ortiz@example.com",
};
const IDENTITY_REQUIRED = { ok: false, error: "identity_verification_required" };

function context(session_id = "test-session"): ToolContext {
  const session = getOrCreateSession(session_id);
  return {
    session_id,
    transcript: session.messages,
    verified_order_numbers: session.verified_order_numbers,
    now: () => NOW,
  };
}

beforeEach(() => {
  reloadStore();
  __clearAllSessions();
});

for (const tool of ["check_return_eligibility", "initiate_return"]) {
  test(`${tool} rejects unverified orders without disclosing or mutating them`, async () => {
    const ctx = context();
    const before = structuredClone(getStore());
    for (const order_number of [ITEM.order_number, "FG-999999"]) {
      assert.deepEqual(
        await runTool(tool, {
          ...ITEM, order_number, reason: "changed_mind",
          // A model-supplied claim must not substitute for server-side state.
          verified_order_numbers: [order_number],
        }, ctx),
        IDENTITY_REQUIRED
      );
    }
    assert.deepEqual(getStore(), before);
  });
}

test("failed lookups do not authorize either return tool", async () => {
  const ctx = context();
  assert.deepEqual(
    await runTool("lookup_order", { ...LOOKUP, customer_email: "wrong@example.com" }, ctx),
    { ok: true, value: { error: "identity_mismatch" } }
  );
  assert.deepEqual(
    await runTool("lookup_order", { ...LOOKUP, order_number: "FG-999999" }, ctx),
    { ok: true, value: null }
  );
  assert.deepEqual(await runTool("check_return_eligibility", ITEM, ctx), IDENTITY_REQUIRED);
  assert.deepEqual(
    await runTool("initiate_return", { ...ITEM, reason: "changed_mind" }, ctx),
    IDENTITY_REQUIRED
  );
  assert.equal(getStore().returns.length, 0);
});

test("successful lookup permits a return on a later turn of the same session", async () => {
  const lookup = await runTool("lookup_order", {
    ...LOOKUP,
    customer_email: LOOKUP.customer_email.toUpperCase(),
  }, context());
  assert.ok(lookup.ok && typeof lookup.value === "object" && lookup.value !== null);
  assert.ok("order_number" in lookup.value);
  assert.equal(lookup.value.order_number, ITEM.order_number);

  // The agent creates a fresh context each tool batch; authorization must survive it.
  const nextTurn = context();
  assert.deepEqual(await runTool("check_return_eligibility", ITEM, nextTurn), {
    ok: true,
    value: { eligible: true, reason: "in_window_unopened" },
  });
  const result = await runTool("initiate_return", { ...ITEM, reason: "changed_mind" }, nextTurn);
  assert.equal(result.ok, true);
  assert.equal(getStore().returns.length, 1);
  const record = getStore().returns[0]!;
  assert.deepEqual(result, {
    ok: true,
    value: {
      rma: record.rma,
      label_url: `https://fieldstone.example/labels/${record.rma}.pdf`,
      fee_usd: 0,
    },
  });
  assert.equal(record.order_number, ITEM.order_number);
  assert.equal(record.item_sku, ITEM.item_sku);
  assert.equal(getStore().orders[0]!.items[0]!.returned, true);
  assert.deepEqual(await runTool("initiate_return", { ...ITEM, reason: "changed_mind" }, nextTurn), {
    ok: true,
    value: { error: "not_eligible", reason: "already_returned" },
  });
  assert.equal(getStore().returns.length, 1);
});

test("verification is specific to an order, not all orders sharing an email", async () => {
  const ctx = context();
  await runTool("lookup_order", LOOKUP, ctx);
  const otherOrder = { order_number: "FG-100006", item_sku: "FG-HOM-001" };
  assert.deepEqual(await runTool("check_return_eligibility", otherOrder, ctx), IDENTITY_REQUIRED);
  assert.deepEqual(
    await runTool("initiate_return", { ...otherOrder, reason: "changed_mind" }, ctx),
    IDENTITY_REQUIRED
  );
});

test("verification does not transfer to another session or a recreated session", async () => {
  await runTool("lookup_order", LOOKUP, context("first"));
  assert.deepEqual(await runTool("check_return_eligibility", ITEM, context("second")), IDENTITY_REQUIRED);
  assert.deepEqual(
    await runTool("initiate_return", { ...ITEM, reason: "changed_mind" }, context("second")),
    IDENTITY_REQUIRED
  );
  __clearAllSessions();
  assert.deepEqual(await runTool("check_return_eligibility", ITEM, context("first")), IDENTITY_REQUIRED);
});

test("a failed re-verification revokes only that order until a successful retry", async () => {
  const ctx = context();
  await runTool("lookup_order", LOOKUP, ctx);
  await runTool("lookup_order", { ...LOOKUP, order_number: "FG-100006" }, ctx);
  await runTool("lookup_order", { ...LOOKUP, customer_email: "wrong@example.com" }, ctx);
  assert.deepEqual(await runTool("check_return_eligibility", ITEM, ctx), IDENTITY_REQUIRED);
  assert.deepEqual(
    await runTool("initiate_return", { ...ITEM, reason: "changed_mind" }, ctx),
    IDENTITY_REQUIRED
  );
  assert.deepEqual(await runTool("check_return_eligibility", {
    order_number: "FG-100006", item_sku: "FG-HOM-001",
  }, ctx), { ok: true, value: { eligible: false, reason: "not_yet_delivered" } });
  await runTool("lookup_order", LOOKUP, ctx);
  assert.deepEqual(await runTool("check_return_eligibility", ITEM, ctx), {
    ok: true,
    value: { eligible: true, reason: "in_window_unopened" },
  });
});

test("verified returns still apply fees and recheck current eligibility", async () => {
  const ctx = context();
  const opened = { order_number: "FG-100002", item_sku: "FG-KIT-001" };
  await runTool("lookup_order", {
    order_number: opened.order_number, customer_email: "devin.park@example.com",
  }, ctx);
  assert.deepEqual(await runTool("check_return_eligibility", opened, ctx), {
    ok: true,
    value: { eligible: true, reason: "in_window_opened_fee", fee_usd: 7.95 },
  });
  const expired = { ...ctx, now: () => new Date("2026-05-07T12:00:00Z") };
  assert.deepEqual(await runTool("initiate_return", { ...opened, reason: "other" }, expired), {
    ok: true,
    value: { error: "not_eligible", reason: "outside_window" },
  });
  assert.equal(getStore().returns.length, 0);
  await runTool("initiate_return", { ...opened, reason: "other" }, ctx);
  assert.equal(getStore().returns[0]!.fee_usd, 7.95);
});
