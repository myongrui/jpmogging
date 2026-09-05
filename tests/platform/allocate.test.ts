import { describe, expect, it } from "vitest";
import { splitCapital } from "../../src/platform/allocate.js";
import { apyFor, quoteFor, type StrategyProfile } from "../../src/platform/strategy.js";
import type { Mandate } from "../../src/shared/types.js";

const profile = (id: string, headlineApy: number, capacity: number, riskScore = 20): StrategyProfile => ({
  id, name: id, family: "amm_lp", headlineApy, capacity, riskScore,
  exitHours: 1, priceDrops: "500000", requires: ["AMM"],
});

const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  asset: "RLUSD", amount: 150000, horizon_hours: 72,
  minimum_liquidity: 0, maximum_risk_score: 30, maximum_protocol_allocation: 1,
  ...over,
});

describe("apyFor", () => {
  it("pays the headline rate inside remaining capacity", () => {
    expect(apyFor(profile("a", 0.05, 100000), 0, 100000)).toBeCloseTo(0.05, 10);
  });

  it("dilutes once capital exceeds capacity", () => {
    // 100k of room at 5%, but 200k deployed: only half earns, so the average halves.
    expect(apyFor(profile("a", 0.05, 100000), 0, 200000)).toBeCloseTo(0.025, 10);
  });

  it("pays nothing once the strategy is full", () => {
    expect(apyFor(profile("a", 0.05, 100000), 100000, 50000)).toBe(0);
  });
});

describe("splitCapital", () => {
  it("splits 150k as 100k at 5% and 50k at 4.5%", () => {
    const quotes = [quoteFor(profile("alpha", 0.05, 100000), 0), quoteFor(profile("beta", 0.045, 200000), 0)];
    const r = splitCapital(mandate(), quotes);
    expect(r.legs.map((l) => [l.sellerId, l.amount])).toEqual([["alpha", 100000], ["beta", 50000]]);
    expect(r.deployed).toBe(150000);
    // (100k * 5% + 50k * 4.5%) / 150k
    expect(r.blendedApy).toBeCloseTo(0.0483333, 6);
    expect(r.legs[0].filledToCapacity).toBe(true);
    expect(r.legs[1].filledToCapacity).toBe(false);
  });

  it("beats a flat per-venue split on blended yield", () => {
    const quotes = [quoteFor(profile("alpha", 0.05, 100000), 0), quoteFor(profile("beta", 0.045, 200000), 0)];
    const capacityAware = splitCapital(mandate(), quotes).blendedApy;
    // A flat 50/50 split ignores that alpha had room for all 100k.
    const flat = 0.5 * 0.05 + 0.5 * 0.045;
    expect(capacityAware).toBeGreaterThan(flat);
  });

  it("concentrates a small mandate into the single best strategy", () => {
    const quotes = [quoteFor(profile("alpha", 0.05, 100000), 0), quoteFor(profile("beta", 0.045, 200000), 0)];
    const r = splitCapital(mandate({ amount: 25000 }), quotes);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ sellerId: "alpha", amount: 25000 });
  });

  it("moves to the next strategy as the best one fills up", () => {
    const quotes = [quoteFor(profile("alpha", 0.05, 100000), 90000), quoteFor(profile("beta", 0.045, 200000), 0)];
    const r = splitCapital(mandate({ amount: 60000 }), quotes);
    expect(r.legs.map((l) => [l.sellerId, l.amount])).toEqual([["alpha", 10000], ["beta", 50000]]);
  });

  it("skips a strategy that is already full and says so", () => {
    const quotes = [quoteFor(profile("alpha", 0.05, 100000), 100000), quoteFor(profile("beta", 0.045, 200000), 0)];
    const r = splitCapital(mandate({ amount: 50000 }), quotes);
    expect(r.legs.map((l) => l.sellerId)).toEqual(["beta"]);
    expect(r.rejected[0].reason).toMatch(/at capacity: 100000 of 100000/);
  });

  it("still honours the concentration cap as a ceiling", () => {
    const quotes = [quoteFor(profile("alpha", 0.05, 100000), 0), quoteFor(profile("beta", 0.045, 200000), 0)];
    const r = splitCapital(mandate({ maximum_protocol_allocation: 0.25 }), quotes);
    expect(r.legs.map((l) => l.amount)).toEqual([37500, 37500]);
    expect(r.deployed).toBe(75000);
  });

  it("still honours the liquidity floor", () => {
    const quotes = [quoteFor(profile("alpha", 0.05, 100000), 0), quoteFor(profile("beta", 0.045, 200000), 0)];
    const r = splitCapital(mandate({ minimum_liquidity: 0.5 }), quotes);
    expect(r.deployed).toBe(75000);
    expect(r.reserve).toBe(75000);
  });

  it("reports capital it could not place inside available capacity", () => {
    const quotes = [quoteFor(profile("alpha", 0.05, 40000), 0)];
    const r = splitCapital(mandate({ amount: 100000 }), quotes);
    expect(r.deployed).toBe(40000);
    expect(r.unplaced).toBe(60000);
    expect(r.reasoning).toMatch(/could not be placed/);
  });

  it("rejects on risk and exit time with a stated reason", () => {
    const quotes = [
      quoteFor({ ...profile("risky", 0.09, 100000, 80) }, 0),
      quoteFor({ ...profile("slow", 0.06, 100000), exitHours: 999 }, 0),
    ];
    const r = splitCapital(mandate({ minimum_liquidity: 0.5 }), quotes);
    expect(r.legs).toHaveLength(0);
    expect(r.rejected.map((x) => x.reason).join()).toMatch(/risk 80 exceeds/);
    expect(r.rejected.map((x) => x.reason).join()).toMatch(/exit 999h exceeds/);
  });

  it("holds everything liquid when nothing fits", () => {
    const r = splitCapital(mandate(), [quoteFor(profile("risky", 0.09, 100000, 80), 0)]);
    expect(r.deployed).toBe(0);
    expect(r.reserve).toBe(150000);
    expect(r.reasoning).toMatch(/holding all capital liquid/);
  });
});
