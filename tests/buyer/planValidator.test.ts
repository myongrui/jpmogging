import { describe, expect, it } from "vitest";
import { validatePlan } from "../../src/buyer/planValidator.js";
import type { ExecutionPlan, PlanLeg } from "../../src/shared/plan.js";
import type { Mandate } from "../../src/shared/types.js";

const mandate: Mandate = {
  asset: "RLUSD",
  amount: 100000,
  horizon_hours: 72,
  minimum_liquidity: 0.5,
  maximum_risk_score: 30,
  maximum_protocol_allocation: 0.25,
};

const leg = (over: Partial<PlanLeg> = {}): PlanLeg => ({
  seq: 1,
  venue: "amm:rPool1",
  kind: "deposit",
  description: "deposit",
  tx: { TransactionType: "AMMDeposit", Asset: { currency: "XRP" }, Amount: "1000" },
  amountRlusd: 25000,
  ...over,
});

const plan = (legs: PlanLeg[], over: Partial<ExecutionPlan> = {}): ExecutionPlan => {
  const deployed = legs.reduce((s, l) => s + l.amountRlusd, 0);
  return {
    planId: "pl_test",
    network: "xrpl:0",
    createdAt: "2026-09-05T00:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z",
    mandate,
    legs,
    totals: { deployed, reserve: mandate.amount - deployed, venues: new Set(legs.map((l) => l.venue)).size },
    ...over,
  };
};

const ctx = { network: "xrpl:0" };

describe("validatePlan", () => {
  it("accepts a plan inside every mandate constraint", () => {
    expect(validatePlan(plan([leg()]), mandate, ctx)).toEqual({ ok: true });
  });

  it("accepts a zero-leg plan, which is how holding everything liquid is expressed", () => {
    expect(validatePlan(plan([]), mandate, ctx)).toEqual({ ok: true });
  });

  it("rejects a plan built for a different network", () => {
    const v = validatePlan(plan([leg()]), mandate, { network: "xrpl:1" });
    expect(v.ok).toBe(false);
    expect((v as any).violations.join()).toMatch(/does not match buyer network/);
  });

  it("rejects an expired plan", () => {
    const v = validatePlan(plan([leg()], { validUntil: "2020-01-01T00:00:00.000Z" }), mandate, ctx);
    expect((v as any).violations.join()).toMatch(/expired/);
  });

  it("rejects a transaction type off the allowlist", () => {
    const bad = leg({ tx: { TransactionType: "Payment", Amount: "1000" } });
    const v = validatePlan(plan([bad]), mandate, ctx);
    expect((v as any).violations.join()).toMatch(/not on the buyer's allowlist/);
  });

  it("rejects a plan that presets a buyer-owned field", () => {
    const bad = leg({ tx: { TransactionType: "AMMDeposit", Account: "rAttacker", Amount: "1000" } });
    const v = validatePlan(plan([bad]), mandate, ctx);
    expect((v as any).violations.join()).toMatch(/presets buyer-owned field Account/);
  });

  it("rejects a leg carrying a Destination", () => {
    const bad = leg({ tx: { TransactionType: "AMMDeposit", Destination: "rAttacker", Amount: "1000" } });
    const v = validatePlan(plan([bad]), mandate, ctx);
    expect((v as any).violations.join()).toMatch(/sets a Destination/);
  });

  it("rejects exposure above the per-protocol cap even when split across legs", () => {
    const legs = [leg({ seq: 1, amountRlusd: 20000 }), leg({ seq: 2, amountRlusd: 10000 })];
    const v = validatePlan(plan(legs), mandate, ctx);
    expect((v as any).violations.join()).toMatch(/exceeds per-protocol cap/);
  });

  it("rejects a plan that breaches the liquidity floor", () => {
    const legs = [
      leg({ seq: 1, venue: "amm:rA", amountRlusd: 25000 }),
      leg({ seq: 2, venue: "amm:rB", amountRlusd: 25000 }),
      leg({ seq: 3, venue: "amm:rC", amountRlusd: 25000 }),
    ];
    const v = validatePlan(plan(legs), mandate, ctx);
    expect((v as any).violations.join()).toMatch(/liquidity floor/);
  });

  it("rejects totals that disagree with the legs", () => {
    const p = plan([leg()]);
    p.totals.deployed = 1;
    const v = validatePlan(p, mandate, ctx);
    expect((v as any).violations.join()).toMatch(/totals claim/);
  });

  it("rejects non-contiguous sequence numbers", () => {
    const legs = [leg({ seq: 1, venue: "amm:rA" }), leg({ seq: 5, venue: "amm:rB" })];
    const v = validatePlan(plan(legs), mandate, ctx);
    expect((v as any).violations.join()).toMatch(/must run 1\.\.n/);
  });
});
