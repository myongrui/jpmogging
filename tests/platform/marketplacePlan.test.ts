import { describe, expect, it } from "vitest";
import type { Market } from "../../src/engine/market.js";
import { buildMarketplacePlan } from "../../src/platform/marketplacePlan.js";
import { DEFAULT_LISTINGS } from "../../src/platform/registry.js";
import type { AllocationLeg } from "../../src/platform/allocate.js";
import type { Mandate, PoolSnapshot } from "../../src/shared/types.js";

const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

const snap = (account: string, drops: string, issuer = RLUSD_ISSUER): PoolSnapshot => ({
  ammAccount: account, pairLabel: `XRP/${account}`, asset2Currency: "USD", asset2Issuer: issuer,
  asset2Name: null, issuerVerified: true, xrpBalanceDrops: drops, asset2Value: "1400000",
  tradingFee: 200, frozen: false,
});

const market: Market = {
  pools: [
    { snapshot: snap("rSafe", "1000000000000"), ledgerIndex: 10, volumeXrpPerDay: 500000 },
    { snapshot: snap("rRisky", "60000000000", "rUnknown"), ledgerIndex: 10, volumeXrpPerDay: 90000 },
  ],
  ledgerIndex: 10,
  rlusdPerXrp: 1.4,
  rateSource: "test",
  sampledAt: "2026-09-05T00:00:00.000Z",
};

const mandate: Mandate = {
  asset: "RLUSD", amount: 150000, horizon_hours: 72,
  minimum_liquidity: 0, maximum_risk_score: 80, maximum_protocol_allocation: 1,
};

const leg = (sellerId: string, amount: number): AllocationLeg => ({
  sellerId, name: sellerId, amount, apy: 0.05, riskScore: 20, filledToCapacity: false,
});

const ctx = { network: "xrpl:0", now: new Date("2026-09-05T00:00:00.000Z"), available: { amm: true } };

describe("buildMarketplacePlan", () => {
  it("merges every strategy's legs into one renumbered sequence", () => {
    const { plan } = buildMarketplacePlan(mandate, [leg("alpha", 100000), leg("beta", 50000)], DEFAULT_LISTINGS, market, ctx);
    expect(plan.legs.map((l) => l.seq)).toEqual(Array.from({ length: plan.legs.length }, (_, i) => i + 1));
    expect(plan.legs.length).toBeGreaterThan(0);
  });

  it("gives every leg the same plan id so the whole allocation reconciles together", () => {
    const { plan } = buildMarketplacePlan(mandate, [leg("alpha", 100000), leg("beta", 50000)], DEFAULT_LISTINGS, market, ctx);
    expect(plan.planId).toMatch(/^pl_/);
    expect(plan.totals.deployed).toBe(150000);
    expect(plan.totals.reserve).toBe(0);
  });

  it("applies the stricter of the mandate and the strategy's own pool ceiling", () => {
    // alpha caps pools at risk 25, so the unverified-issuer pool is unreachable
    // to it even though the mandate would allow risk 80.
    const { strategies } = buildMarketplacePlan(mandate, [leg("alpha", 100000)], DEFAULT_LISTINGS, market, ctx);
    expect(strategies[0].pools.every((p) => p.riskScore <= 25)).toBe(true);
  });

  it("lets a looser strategy reach pools a stricter one cannot", () => {
    const strict = buildMarketplacePlan(mandate, [leg("alpha", 100000)], DEFAULT_LISTINGS, market, ctx);
    const loose = buildMarketplacePlan(mandate, [leg("gamma", 40000)], DEFAULT_LISTINGS, market, ctx);
    const strictMax = Math.max(...strict.strategies[0].pools.map((p) => p.riskScore));
    const looseMax = Math.max(...loose.strategies[0].pools.map((p) => p.riskScore));
    expect(looseMax).toBeGreaterThanOrEqual(strictMax);
  });

  it("reports which pools each strategy chose, and why", () => {
    const { strategies } = buildMarketplacePlan(mandate, [leg("alpha", 100000)], DEFAULT_LISTINGS, market, ctx);
    expect(strategies[0]).toMatchObject({ strategyId: "alpha", name: "Alpha Deep LP", amount: 100000 });
    expect(strategies[0].reasoning).toMatch(/selected|satisfied/);
  });

  it("emits legs with no buyer-owned fields preset", () => {
    const { plan } = buildMarketplacePlan(mandate, [leg("alpha", 100000)], DEFAULT_LISTINGS, market, ctx);
    for (const l of plan.legs) {
      for (const f of ["Account", "Sequence", "Fee", "LastLedgerSequence"]) expect(f in l.tx).toBe(false);
    }
  });

  it("produces no legs when the network cannot execute the venue", () => {
    const { plan } = buildMarketplacePlan(mandate, [leg("alpha", 100000)], DEFAULT_LISTINGS, market, { ...ctx, available: { amm: false } });
    expect(plan.legs).toHaveLength(0);
    expect(plan.totals.deployed).toBe(0);
  });

  it("keeps two strategies that pick the same pool inside one venue cap", () => {
    // Both strategies rank rSafe first, so without a shared budget the merged
    // plan would put 2x the cap into one venue.
    const capped: Mandate = { ...mandate, maximum_protocol_allocation: 0.25 };
    const { plan, strategies, crowdedOut } = buildMarketplacePlan(
      capped,
      [leg("alpha", 60000), leg("beta", 60000)],
      DEFAULT_LISTINGS,
      market,
      ctx,
    );
    const perVenue = new Map<string, number>();
    for (const l of plan.legs) perVenue.set(l.venue, (perVenue.get(l.venue) ?? 0) + l.amountRlusd);
    const cap = capped.amount * capped.maximum_protocol_allocation;
    for (const [, exposure] of perVenue) expect(exposure).toBeLessThanOrEqual(cap + 1e-6);
    expect(crowdedOut).toBeGreaterThan(0);
    expect(strategies.some((s2) => /crowded out/.test(s2.reasoning))).toBe(true);
  });

  it("reports the amount each strategy actually placed, not what it was offered", () => {
    const capped: Mandate = { ...mandate, maximum_protocol_allocation: 0.1 };
    const { strategies } = buildMarketplacePlan(capped, [leg("alpha", 60000)], DEFAULT_LISTINGS, market, ctx);
    const placed = strategies.reduce((s2, x) => s2 + x.amount, 0);
    expect(placed).toBeLessThan(60000);
    expect(placed).toBeLessThanOrEqual(capped.amount * capped.maximum_protocol_allocation * 2 + 1e-6);
  });

  it("skips a leg whose strategy is not in the registry", () => {
    const { plan, strategies } = buildMarketplacePlan(mandate, [leg("ghost", 100000)], DEFAULT_LISTINGS, market, ctx);
    expect(strategies).toHaveLength(0);
    expect(plan.legs).toHaveLength(0);
  });
});
