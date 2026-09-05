import "dotenv/config";
import { readFileSync } from "node:fs";
import { Client } from "xrpl";
import type { StrategyProfile } from "../platform/strategy.js";
import { CapacityBook } from "./book.js";
import { listOpportunities, ledgerDiscoverer, marketCache, runAnalysis } from "../engine/engine.js";
import { readAmendments } from "../execute/amendments.js";
import { buildSellerApp } from "./app.js";

const port = Number(process.env.SELLER_PORT ?? "8080");
const payTo = process.env.XRPL_PAY_TO;
if (!payTo) throw new Error("XRPL_PAY_TO is required");

// A seller advertises one strategy: its headline rate, its capacity, and how
// full it is. Without a profile it still sells analysis, it just publishes no quote.
const profilePath = process.env.STRATEGY_PROFILE;
const profile: StrategyProfile | undefined = profilePath
  ? (JSON.parse(readFileSync(profilePath, "utf8")) as StrategyProfile)
  : undefined;
const book = profile ? new CapacityBook(profile) : undefined;

const cfg = {
  payTo,
  network: process.env.XRPL_NETWORK ?? "xrpl:1",
  facilitatorUrl: process.env.XRPL_FACILITATOR_URL ?? "https://xrpl-facilitator-testnet.t54.ai",
  priceDrops: process.env.XRPL_PRICE_DROPS ?? profile?.priceDrops ?? "500000",
  baseUrl: process.env.SELLER_BASE_URL ?? `http://127.0.0.1:${port}`,
};

/**
 * Which ledger the analysis reads. Recommendations must name pools that exist
 * where the buyer's wallet lives, so this has to agree with the payment network.
 */
const engineNetwork = process.env.XRPL_ENGINE_NETWORK ?? "mainnet";
const isTestnet = engineNetwork === "testnet";
const ws = isTestnet
  ? (process.env.XRPL_TESTNET_WS ?? "wss://s.altnet.rippletest.net:51233")
  : (process.env.XRPL_MAINNET_WS ?? "wss://s1.ripple.com:51233");

const client = new Client(ws);
await client.connect();
const amendments = await readAmendments(client);

// Mainnet has an indexer in front of it; testnet does not, so pools are read
// straight off the ledger there.
const discover = isTestnet ? ledgerDiscoverer(client) : undefined;
const deps = { rpc: client, network: cfg.network, discover, amendments };

// Pool data is identical for every buyer, and x402 settles payment before the
// handler runs — so a throttled node on the paid path means a buyer who paid
// and got nothing. Refresh on a timer instead, and warm before accepting calls.
const marketTtlMs = Number(process.env.MARKET_TTL_MS ?? "60000");
const market = marketCache(deps, marketTtlMs);
// Warm in the background so free tools and quotes serve immediately; the paid
// endpoint refuses with 503 until the snapshot exists.
console.log("warming market data in the background...");
void market.warm().then(() => {
  const w = market.snapshot;
  console.log(w ? `market ready: ${w.pools.length} pools at ledger ${w.ledgerIndex}` : "market warm failed; will retry");
});
setInterval(() => void market.warm(), marketTtlMs).unref();

const engine = {
  listOpportunities: () => listOpportunities(deps),
  quote: book ? () => book.quote() : undefined,
  ready: () => market.snapshot !== undefined,
  runAnalysis: async (mandate: Parameters<typeof runAnalysis>[1]) => {
    const result = await runAnalysis({ ...deps, market }, mandate);
    // Capital promised in a plan is capital this strategy can no longer offer,
    // so the next quote reflects it.
    if (book && result.plan) book.commit(result.plan.planId, result.plan.totals.deployed);
    return result;
  },
};

buildSellerApp(cfg, engine).listen(port, "127.0.0.1", () => {
  console.log(`seller listening on ${cfg.baseUrl}`);
  console.log(`MCP endpoint ${cfg.baseUrl}/mcp`);
  console.log(`engine reading ${engineNetwork} via ${ws}`);
  console.log(`paid resource ${cfg.baseUrl}/api/optimize_allocation at ${cfg.priceDrops} drops -> ${cfg.payTo}`);
  if (profile) {
    console.log(`strategy ${profile.id} "${profile.name}": ${(profile.headlineApy * 100).toFixed(1)}% APY up to ${profile.capacity}, risk ${profile.riskScore}, exit ${profile.exitHours}h`);
  }
});
