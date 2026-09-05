import "dotenv/config";
import { Client } from "xrpl";
import { ledgerDiscoverer, marketCache, RLUSD_AMM_ACCOUNT } from "../engine/engine.js";
import { availability } from "../execute/adapters/index.js";
import { readAmendments } from "../execute/amendments.js";
import type { Mandate } from "../shared/types.js";
import { buildPlatformApp } from "./app.js";
import { CapacityBook } from "./book.js";
import { buildMarketplacePlan } from "./marketplacePlan.js";
import { orchestrate } from "./orchestrate.js";
import { loadRegistry } from "./registry.js";
import { RevenueLedger, splitFee } from "./revenue.js";

const port = Number(process.env.PLATFORM_PORT ?? "8081");
const payTo = process.env.XRPL_PLATFORM_PAY_TO ?? process.env.XRPL_PAY_TO;
if (!payTo) throw new Error("XRPL_PLATFORM_PAY_TO (or XRPL_PAY_TO) is required");

const cfg = {
  payTo,
  network: process.env.XRPL_NETWORK ?? "xrpl:1",
  facilitatorUrl: process.env.XRPL_FACILITATOR_URL ?? "https://xrpl-facilitator-testnet.t54.ai",
  priceDrops: process.env.XRPL_PRICE_DROPS ?? "500000",
  listPriceDrops: process.env.XRPL_LIST_PRICE_DROPS ?? "10000",
  // Basis points of every fee the platform keeps; the rest is owed to the
  // strategy authors whose strategies actually placed capital.
  cutBps: Number(process.env.PLATFORM_CUT_BPS ?? "2000"),
  baseUrl: process.env.PLATFORM_BASE_URL ?? `http://127.0.0.1:${port}`,
};

const revenue = new RevenueLedger(process.env.REVENUE_DIR ?? "runs");

/** Which ledger the engine reads. Must agree with the payment network. */
const engineNetwork = process.env.XRPL_ENGINE_NETWORK ?? "mainnet";
const isTestnet = engineNetwork === "testnet";
const ws = isTestnet
  ? (process.env.XRPL_TESTNET_WS ?? "wss://s.altnet.rippletest.net:51233")
  : (process.env.XRPL_MAINNET_WS ?? "wss://s1.ripple.com:51233");

const client = new Client(ws);
await client.connect();
const amendments = await readAmendments(client);
const profiles = loadRegistry(process.env.PLATFORM_REGISTRY);
const books = new Map(profiles.map((p) => [p.id, new CapacityBook(p)]));

const deps = {
  rpc: client,
  network: cfg.network,
  discover: isTestnet ? ledgerDiscoverer(client) : undefined,
  referenceAccount: RLUSD_AMM_ACCOUNT,
  amendments,
};

const marketTtlMs = Number(process.env.MARKET_TTL_MS ?? "60000");
const market = marketCache(deps, marketTtlMs);
console.log("warming market data in the background...");
void market.warm().then(() => {
  const w = market.snapshot;
  console.log(w ? `market ready: ${w.pools.length} pools at ledger ${w.ledgerIndex}` : "market warm failed; will retry");
});
setInterval(() => void market.warm(), marketTtlMs).unref();

const engine = {
  ready: () => market.snapshot !== undefined,
  quotes: () => profiles.map((p) => books.get(p.id)!.quote()),
  recordListingFee: () => {
    // A listing is the platform's own product, so none of it is owed onward.
    revenue.record({
      ts: new Date().toISOString(),
      kind: "list",
      feeDrops: cfg.listPriceDrops,
      split: { platformDrops: cfg.listPriceDrops, strategyDrops: {} },
    });
  },
  allocate: async (mandate: Mandate) => {
    const quotes = profiles.map((p) => books.get(p.id)!.quote());
    const split = orchestrate(mandate, profiles, quotes, amendments);
    const snapshot = await market.get();
    const built = buildMarketplacePlan(mandate, split.legs, profiles, snapshot, {
      network: cfg.network,
      now: new Date(),
      available: availability(amendments),
    });
    // Capital promised in a plan is capital a strategy can no longer offer.
    for (const leg of split.legs) books.get(leg.sellerId)?.commit(built.plan.planId, leg.amount);

    // Strategies earn on what they actually placed, so one crowded out of every
    // venue earns nothing from this call.
    revenue.record({
      ts: new Date().toISOString(),
      kind: "allocate",
      planId: built.plan.planId,
      feeDrops: cfg.priceDrops,
      split: splitFee(
        cfg.priceDrops,
        cfg.cutBps,
        built.strategies.map((s) => ({ strategyId: s.strategyId, amount: s.amount })),
      ),
    });
    return { ...split, ...built };
  },
};

buildPlatformApp(cfg, engine).listen(port, "127.0.0.1", () => {
  console.log(`platform listening on ${cfg.baseUrl}`);
  console.log(`MCP endpoint ${cfg.baseUrl}/mcp`);
  console.log(`engine reading ${engineNetwork} via ${ws}`);
  console.log(`paid: ${cfg.baseUrl}/api/strategies at ${cfg.listPriceDrops} drops · ${cfg.baseUrl}/api/allocate at ${cfg.priceDrops} drops -> ${cfg.payTo}`);
  console.log(`platform cut ${cfg.cutBps / 100}% · revenue ledger ${revenue.path}`);
  for (const p of profiles) {
    console.log(`  ${p.id.padEnd(6)} ${(p.headlineApy * 100).toFixed(1)}% up to ${String(p.capacity).padStart(7)} · risk ${p.riskScore} · pool risk <= ${p.maxPoolRisk} · exit ${p.exitHours}h`);
  }
});
