import { describe, expect, it } from "vitest";
import { orchestrate, riskBand } from "../../src/platform/orchestrate.js";
import { DEFAULT_LISTINGS } from "../../src/platform/registry.js";
import { quoteFor, type StrategyProfile } from "../../src/platform/strategy.js";
import type { Mandate } from "../../src/shared/types.js";

const live = (names: string[]) => ({ known: true, enabled: new Set(names) });
const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  asset: "RLUSD", amount: 150000, horizon_hours: 72,
  minimum_liquidity: 0, maximum_risk_score: 30, maximum_protocol_allocation: 1,
  ...over,
});

const quotes = (deployed: Record<string, number> = {}, profiles: StrategyProfile[] = DEFAULT_LISTINGS) =>
  profiles.map((p) => quoteFor(p, deployed[p.id] ?? 0));

describe("riskBand", () => {
  it("reads the band off the mandate's own ceiling", () => {
    expect(riskBand(mandate({ maximum_risk_score: 20 }))).toBe("conservative");
    expect(riskBand(mandate({ maximum_risk_score: 30 }))).toBe("moderate");
    expect(riskBand(mandate({ maximum_risk_score: 60 }))).toBe("aggressive");
  });
});

describe("orchestrate", () => {
  it("fills the highest-paying strategy first, then works down", () => {
    const r = orchestrate(mandate(), DEFAULT_LISTINGS, quotes(), live(["AMM"]));
    expect(r.legs.map((l) => [l.sellerId, l.amount])).toEqual([
      ["gamma", 40000],
      ["alpha", 100000],
      ["beta", 10000],
    ]);
    expect(r.deployed).toBe(150000);
    expect(r.blendedApy).toBeCloseTo((40000 * 0.062 + 100000 * 0.05 + 10000 * 0.045) / 150000, 10);
  });

  it("reproduces the two-strategy split when the top payer is out of risk range", () => {
    const r = orchestrate(mandate({ maximum_risk_score: 26 }), DEFAULT_LISTINGS, quotes(), live(["AMM"]));
    expect(r.legs.map((l) => [l.sellerId, l.amount])).toEqual([["alpha", 100000], ["beta", 50000]]);
    expect(r.blendedApy).toBeCloseTo(0.0483333, 6);
    expect(r.rejected.find((x) => x.sellerId === "gamma")!.reason).toMatch(/risk 29 exceeds ceiling 26/);
  });

  it("re-splits as capacity fills up", () => {
    const r = orchestrate(mandate({ amount: 60000 }), DEFAULT_LISTINGS, quotes({ gamma: 40000, alpha: 90000 }), live(["AMM"]));
    expect(r.legs.map((l) => [l.sellerId, l.amount])).toEqual([["alpha", 10000], ["beta", 50000]]);
    expect(r.rejected.find((x) => x.sellerId === "gamma")!.reason).toMatch(/at capacity/);
  });

  it("routes a small mandate to one strategy rather than splitting it", () => {
    const r = orchestrate(mandate({ amount: 25000 }), DEFAULT_LISTINGS, quotes(), live(["AMM"]));
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ sellerId: "gamma", amount: 25000 });
  });

  it("drops strategies whose amendments are not enabled before allocating", () => {
    const gated: StrategyProfile[] = [{ ...DEFAULT_LISTINGS[0], requires: ["SingleAssetVault"] }, DEFAULT_LISTINGS[1]];
    const r = orchestrate(mandate(), gated, quotes({}, gated), live(["AMM"]));
    expect(r.legs.map((l) => l.sellerId)).toEqual(["beta"]);
    expect(r.rejected[0].reason).toMatch(/requires SingleAssetVault/);
  });

  it("refuses to allocate when the network's amendment state is unknown", () => {
    const r = orchestrate(mandate(), DEFAULT_LISTINGS, quotes(), { known: false, enabled: new Set() });
    expect(r.legs).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/amendment state unknown/);
  });

  it("reports capital that exceeds all available capacity", () => {
    const r = orchestrate(mandate({ amount: 400000 }), DEFAULT_LISTINGS, quotes(), live(["AMM"]));
    expect(r.deployed).toBe(340000);
    expect(r.unplaced).toBe(60000);
  });
});
