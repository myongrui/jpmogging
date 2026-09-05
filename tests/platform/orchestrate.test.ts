import { describe, expect, it } from "vitest";
import { fetchQuotes, orchestrate } from "../../src/platform/orchestrate.js";
import { DEFAULT_LISTINGS, type SellerListing } from "../../src/platform/registry.js";
import { quoteFor } from "../../src/platform/strategy.js";
import type { Mandate } from "../../src/shared/types.js";

const live = (names: string[]) => ({ known: true, enabled: new Set(names) });
const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  asset: "RLUSD", amount: 150000, horizon_hours: 72,
  minimum_liquidity: 0, maximum_risk_score: 30, maximum_protocol_allocation: 1,
  ...over,
});

/** Answers /api/quote for the given per-seller deployed figures. */
function quoteServer(deployed: Record<string, number>, listings = DEFAULT_LISTINGS): typeof fetch {
  return (async (url: string | URL) => {
    const id = listings.find((l) => String(url).startsWith(l.baseUrl))!.id;
    const listing = listings.find((l) => l.id === id)!;
    return new Response(JSON.stringify(quoteFor(listing, deployed[id] ?? 0)));
  }) as unknown as typeof fetch;
}

const unreachable = (async () => {
  throw new Error("connection refused");
}) as unknown as typeof fetch;

describe("fetchQuotes", () => {
  it("falls back to listed figures and flags the seller as stale", async () => {
    const { quotes, stale } = await fetchQuotes(DEFAULT_LISTINGS, unreachable);
    expect(stale.sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(quotes).toHaveLength(3);
    expect(quotes.every((q) => q.deployed === 0)).toBe(true);
  });
});

describe("orchestrate", () => {
  it("fills the highest-paying strategy first, then works down", async () => {
    const r = await orchestrate(mandate(), DEFAULT_LISTINGS, live(["AMM"]), quoteServer({}));
    // gamma 6.2% (cap 40k), alpha 5.0% (cap 100k), beta 4.5% takes the rest.
    expect(r.legs.map((l) => [l.sellerId, l.amount])).toEqual([
      ["gamma", 40000],
      ["alpha", 100000],
      ["beta", 10000],
    ]);
    expect(r.deployed).toBe(150000);
    expect(r.blendedApy).toBeCloseTo((40000 * 0.062 + 100000 * 0.05 + 10000 * 0.045) / 150000, 10);
  });

  it("reproduces the two-strategy split when the top payer is out of risk range", async () => {
    const r = await orchestrate(mandate({ maximum_risk_score: 26 }), DEFAULT_LISTINGS, live(["AMM"]), quoteServer({}));
    expect(r.legs.map((l) => [l.sellerId, l.amount])).toEqual([["alpha", 100000], ["beta", 50000]]);
    expect(r.blendedApy).toBeCloseTo(0.0483333, 6);
    expect(r.rejected.find((x) => x.sellerId === "gamma")!.reason).toMatch(/risk 29 exceeds ceiling 26/);
  });

  it("re-splits as capacity fills up", async () => {
    // gamma full, alpha 90k in: only 10k of alpha left before beta takes over.
    const r = await orchestrate(mandate({ amount: 60000 }), DEFAULT_LISTINGS, live(["AMM"]), quoteServer({ gamma: 40000, alpha: 90000 }));
    expect(r.legs.map((l) => [l.sellerId, l.amount])).toEqual([["alpha", 10000], ["beta", 50000]]);
    expect(r.rejected.find((x) => x.sellerId === "gamma")!.reason).toMatch(/at capacity/);
  });

  it("routes a small mandate to one seller rather than splitting it", async () => {
    const r = await orchestrate(mandate({ amount: 25000 }), DEFAULT_LISTINGS, live(["AMM"]), quoteServer({}));
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ sellerId: "gamma", amount: 25000 });
  });

  it("marks legs priced off a stale quote", async () => {
    const r = await orchestrate(mandate(), DEFAULT_LISTINGS, live(["AMM"]), unreachable);
    expect(r.legs.every((l) => l.quoteLive === false)).toBe(true);
    expect(r.staleQuotes.sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("drops strategies whose amendments are not enabled before allocating", async () => {
    const gated: SellerListing[] = [{ ...DEFAULT_LISTINGS[0], requires: ["SingleAssetVault"] }, DEFAULT_LISTINGS[1]];
    const r = await orchestrate(mandate(), gated, live(["AMM"]), quoteServer({}, gated));
    expect(r.legs.map((l) => l.sellerId)).toEqual(["beta"]);
    expect(r.rejected[0].reason).toMatch(/requires SingleAssetVault/);
  });

  it("hands back an MCP endpoint and price for every leg", async () => {
    const r = await orchestrate(mandate({ amount: 20000 }), DEFAULT_LISTINGS, live(["AMM"]), quoteServer({}));
    expect(r.legs[0].endpoint).toBe("http://127.0.0.1:8083/mcp");
    expect(r.legs[0].priceDrops).toBe("600000");
  });

  it("reports capital that exceeds all available capacity", async () => {
    const r = await orchestrate(mandate({ amount: 400000 }), DEFAULT_LISTINGS, live(["AMM"]), quoteServer({}));
    expect(r.deployed).toBe(340000);
    expect(r.unplaced).toBe(60000);
  });
});
