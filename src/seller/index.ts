import "dotenv/config";
import { Client } from "xrpl";
import { listOpportunities, runAnalysis } from "../engine/engine.js";
import { buildSellerApp } from "./app.js";

const port = Number(process.env.SELLER_PORT ?? "8080");
const payTo = process.env.XRPL_PAY_TO;
if (!payTo) throw new Error("XRPL_PAY_TO is required");

const cfg = {
  payTo,
  network: process.env.XRPL_NETWORK ?? "xrpl:1",
  facilitatorUrl: process.env.XRPL_FACILITATOR_URL ?? "https://xrpl-facilitator-testnet.t54.ai",
  priceDrops: process.env.XRPL_PRICE_DROPS ?? "500000",
  baseUrl: process.env.SELLER_BASE_URL ?? `http://127.0.0.1:${port}`,
};

const mainnet = new Client(process.env.XRPL_MAINNET_WS ?? "wss://s1.ripple.com:51233");
await mainnet.connect();

const engine = {
  listOpportunities: () => listOpportunities({ rpc: mainnet }),
  runAnalysis: (mandate: Parameters<typeof runAnalysis>[1]) => runAnalysis({ rpc: mainnet }, mandate),
};

buildSellerApp(cfg, engine).listen(port, "127.0.0.1", () => {
  console.log(`seller listening on ${cfg.baseUrl}`);
  console.log(`MCP endpoint ${cfg.baseUrl}/mcp`);
  console.log(`paid resource ${cfg.baseUrl}/api/optimize_allocation at ${cfg.priceDrops} drops -> ${cfg.payTo}`);
});
