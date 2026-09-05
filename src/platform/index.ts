import "dotenv/config";
import { Client } from "xrpl";
import { readAmendments } from "../execute/amendments.js";
import type { Mandate } from "../shared/types.js";
import { buildPlatformApp } from "./app.js";
import { orchestrate } from "./orchestrate.js";
import { loadRegistry } from "./registry.js";

const port = Number(process.env.PLATFORM_PORT ?? "8081");
const payTo = process.env.XRPL_PLATFORM_PAY_TO ?? process.env.XRPL_PAY_TO;
if (!payTo) throw new Error("XRPL_PLATFORM_PAY_TO (or XRPL_PAY_TO) is required");

const cfg = {
  payTo,
  network: process.env.XRPL_NETWORK ?? "xrpl:1",
  facilitatorUrl: process.env.XRPL_FACILITATOR_URL ?? "https://xrpl-facilitator-testnet.t54.ai",
  priceDrops: process.env.XRPL_MATCH_PRICE_DROPS ?? "100000",
  baseUrl: process.env.PLATFORM_BASE_URL ?? `http://127.0.0.1:${port}`,
};

const ws = process.env.XRPL_TESTNET_WS ?? "wss://s.altnet.rippletest.net:51233";
const client = new Client(ws);
await client.connect();
const amendments = await readAmendments(client);
const listings = loadRegistry(process.env.PLATFORM_REGISTRY);

const engine = {
  listSellers: () => listings,
  orchestrate: async (mandate: Mandate) => orchestrate(mandate, listings, amendments),
};

buildPlatformApp(cfg, engine).listen(port, "127.0.0.1", () => {
  console.log(`platform listening on ${cfg.baseUrl}`);
  console.log(`MCP endpoint ${cfg.baseUrl}/mcp`);
  console.log(`match fee ${cfg.priceDrops} drops -> ${cfg.payTo}`);
  console.log(`registry: ${listings.length} sellers; amendments known: ${amendments.known}`);
  for (const l of listings) {
    console.log(`  ${l.id.padEnd(6)} ${(l.headlineApy * 100).toFixed(1)}% up to ${String(l.capacity).padStart(7)} · risk ${l.riskScore} · exit ${l.exitHours}h · ${l.baseUrl}`);
  }
});
