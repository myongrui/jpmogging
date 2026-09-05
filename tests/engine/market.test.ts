import { describe, expect, it, vi } from "vitest";
import { MarketCache, resolveRate, type MarketPool } from "../../src/engine/market.js";
import type { PoolSnapshot } from "../../src/shared/types.js";

const snap = (account: string, drops: string, value: string): PoolSnapshot => ({
  ammAccount: account, pairLabel: "XRP/X", asset2Currency: "USD", asset2Issuer: "rI",
  asset2Name: null, issuerVerified: true, xrpBalanceDrops: drops, asset2Value: value,
  tradingFee: 200, frozen: false,
});
const pool = (account: string, drops: string, value: string): MarketPool =>
  ({ snapshot: snap(account, drops, value), ledgerIndex: 1, volumeXrpPerDay: 0 });

describe("resolveRate", () => {
  it("prefers the reference pool", () => {
    const r = resolveRate([pool("rRef", "1000000000", "1400"), pool("rBig", "9000000000", "900")], "rRef");
    expect(r.rlusdPerXrp).toBeCloseTo(1.4, 10);
    expect(r.source).toMatch(/reference pool rRef/);
  });

  it("falls back to the deepest pool when the reference is missing", () => {
    const r = resolveRate([pool("rSmall", "1000000000", "1000"), pool("rBig", "9000000000", "18000")], "rRef");
    expect(r.rlusdPerXrp).toBeCloseTo(2, 10);
    expect(r.source).toMatch(/deepest pool rBig/);
  });

  it("says so when no pool quotes a usable rate", () => {
    const r = resolveRate([pool("rA", "1000000000", "0")], "rRef");
    expect(r.rlusdPerXrp).toBe(1);
    expect(r.source).toMatch(/fallback 1:1/);
  });
});

function cacheWith(loads: Array<() => Promise<PoolSnapshot[]>>, ttl = 1000, clock = () => Date.now()) {
  let i = 0;
  const discover = () => loads[Math.min(i++, loads.length - 1)]();
  const rpc = {
    request: async (req: any) =>
      req.command === "amm_info"
        ? { result: { amm: { amount: "1000000000", amount2: { value: "1400" }, trading_fee: 200 }, ledger_index: 7 } }
        : { result: { transactions: [] } },
  };
  return {
    cache: new MarketCache({ rpc, discover, referenceAccount: "rRef" }, ttl, clock),
    calls: () => i,
  };
}

describe("MarketCache", () => {
  it("loads once and serves the snapshot while it is fresh", async () => {
    const { cache, calls } = cacheWith([async () => [snap("rRef", "1000000000", "1400")]]);
    await cache.get();
    await cache.get();
    expect(calls()).toBe(1);
    expect(cache.snapshot!.pools).toHaveLength(1);
  });

  it("reloads once the entry goes stale", async () => {
    let t = 0;
    const { cache, calls } = cacheWith([async () => [snap("rRef", "1000000000", "1400")]], 1000, () => t);
    await cache.get();
    t = 5000;
    await cache.get();
    expect(calls()).toBe(2);
  });

  it("collapses concurrent misses into a single load", async () => {
    const { cache, calls } = cacheWith([
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        return [snap("rRef", "1000000000", "1400")];
      },
    ]);
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(calls()).toBe(1);
  });

  it("keeps serving stale data when a refresh fails, rather than throwing at a paying caller", async () => {
    let t = 0;
    const { cache } = cacheWith(
      [async () => [snap("rRef", "1000000000", "1400")], async () => { throw new Error("too much load"); }],
      1000,
      () => t,
    );
    await cache.get();
    t = 5000;
    const m = await cache.get();
    expect(m.pools).toHaveLength(1);
  });

  it("propagates the failure when there is nothing cached yet", async () => {
    const { cache } = cacheWith([async () => { throw new Error("too much load"); }]);
    await expect(cache.get()).rejects.toThrow("too much load");
  });

  it("warm swallows failures so a boot-time outage is not fatal", async () => {
    const { cache } = cacheWith([async () => { throw new Error("too much load"); }]);
    await expect(cache.warm()).resolves.toBeUndefined();
    expect(cache.snapshot).toBeUndefined();
  });
});
