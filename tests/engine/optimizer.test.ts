import { describe, expect, it } from "vitest";
import { optimizeAllocation } from "../../src/engine/optimizer.js";
import type { Mandate, PoolMetrics } from "../../src/shared/types.js";

const mandate: Mandate = {
  asset: "RLUSD",
  amount: 100000,
  horizon_hours: 72,
  minimum_liquidity: 0.5,
  maximum_risk_score: 30,
  maximum_protocol_allocation: 0.25,
};

function pool(over: Partial<PoolMetrics>): PoolMetrics {
  return {
    ammAccount: "rPool",
    pairLabel: "XRP/TEST",
    asset2Currency: "TST",
    asset2Issuer: "rIssuer",
    asset2Name: null,
    issuerVerified: false,
    xrpBalanceDrops: "0",
    asset2Value: "0",
    tradingFee: 100,
    frozen: false,
    tvlXrp: 1_000_000,
    volumeXrpPerDay: 100_000,
    feeApy: 0.05,
    riskScore: 20,
    liquidityScore: 90,
    riskAdjustedScore: 0.04,
    ...over,
  };
}

const ctx = { rlusdPerXrp: 1.4, ledgerIndex: 100, sampledAt: "2026-09-04T00:00:00.000Z", now: new Date("2026-09-04T12:00:00.000Z") };

describe("optimizeAllocation", () => {
  it("keeps the liquidity reserve and caps each pool at the concentration limit", () => {
    const a = pool({ ammAccount: "rA", pairLabel: "XRP/A", feeApy: 0.08, riskScore: 25, riskAdjustedScore: 0.06 });
    const b = pool({ ammAccount: "rB", pairLabel: "XRP/B", feeApy: 0.05, riskScore: 20, riskAdjustedScore: 0.04 });
    const c = pool({ ammAccount: "rC", pairLabel: "XRP/C", feeApy: 0.3, riskScore: 60, riskAdjustedScore: 0.12 });
    const r = optimizeAllocation(mandate, [b, c, a], ctx);

    expect(r.recommendation).toBe("XRP/A");
    expect(r.allocations.map((l) => [l.pairLabel, l.weight, l.amount])).toEqual([
      ["XRP/A", 0.25, 25000],
      ["XRP/B", 0.25, 25000],
    ]);
    expect(r.liquid_reserve).toEqual({ weight: 0.5, amount: 50000 });
    expect(r.expected_apy).toBeCloseTo(0.25 * 0.08 + 0.25 * 0.05, 10);
    expect(r.portfolio_risk_score).toBe(22.5);
    expect(r.opportunities_considered).toBe(3);
    expect(r.valid_until).toBe("2026-09-04T13:00:00.000Z");
    expect(r.data).toEqual({ ledger_index: 100, rlusd_per_xrp: 1.4, sampled_at: ctx.sampledAt });
  });

  it("holds everything liquid when no pool satisfies the mandate", () => {
    const r = optimizeAllocation(mandate, [pool({ riskScore: 80 }), pool({ liquidityScore: 10 }), pool({ frozen: true })], ctx);
    expect(r.recommendation).toBe("hold_liquid");
    expect(r.allocations).toEqual([]);
    expect(r.liquid_reserve).toEqual({ weight: 1, amount: 100000 });
    expect(r.expected_apy).toBe(0);
    expect(r.portfolio_risk_score).toBe(0);
    expect(r.portfolio_liquidity_score).toBe(100);
  });

  it("holds everything liquid when the per-protocol cap is zero", () => {
    const r = optimizeAllocation({ ...mandate, maximum_protocol_allocation: 0 }, [pool({})], ctx);
    expect(r.recommendation).toBe("hold_liquid");
    expect(r.allocations).toEqual([]);
    expect(r.liquid_reserve).toEqual({ weight: 1, amount: 100000 });
  });

  it("returns leftover deployable capital to the reserve when few pools qualify", () => {
    const r = optimizeAllocation(mandate, [pool({ pairLabel: "XRP/ONLY" })], ctx);
    expect(r.allocations).toHaveLength(1);
    expect(r.liquid_reserve).toEqual({ weight: 0.75, amount: 75000 });
  });
});
