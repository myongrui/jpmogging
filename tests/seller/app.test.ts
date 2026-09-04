import type { RequestHandler } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSellerApp } from "../../src/seller/app.js";
import type { SellerConfig } from "../../src/seller/mcp.js";
import type { AllocationResult } from "../../src/shared/types.js";

const cfg: SellerConfig = { payTo: "rSeller", network: "xrpl:1", facilitatorUrl: "http://unused", priceDrops: "500000", baseUrl: "" };

const fakeResult: AllocationResult = {
  recommendation: "XRP/RLUSD",
  allocations: [],
  liquid_reserve: { weight: 1, amount: 100000 },
  expected_apy: 0,
  portfolio_risk_score: 0,
  portfolio_liquidity_score: 100,
  reasoning: "test",
  opportunities_considered: 0,
  data: { ledger_index: 1, rlusd_per_xrp: 1.4, sampled_at: "t" },
  timestamp: "t",
  valid_until: "t",
};

let seen: unknown[] = [];
const passThrough: RequestHandler = (_req, _res, next) => {
  seen.push("guard");
  next();
};

const engine = {
  listOpportunities: async () => [],
  runAnalysis: async (mandate: unknown) => {
    seen.push(mandate);
    return fakeResult;
  },
};

let baseUrl = "";
let server: ReturnType<ReturnType<typeof buildSellerApp>["listen"]>;

beforeAll(async () => {
  const app = buildSellerApp({ ...cfg, baseUrl: "" }, engine, { paymentGuard: passThrough });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server.close());

describe("seller app", () => {
  it("reports health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("serves the MCP endpoint over Streamable HTTP", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_opportunities", "optimize_allocation"]);
    await client.close();
  });

  it("runs the paid analysis behind the payment guard", async () => {
    seen = [];
    const mandate = { asset: "RLUSD", amount: 100000, horizon_hours: 72, minimum_liquidity: 0.5, maximum_risk_score: 30, maximum_protocol_allocation: 0.25 };
    const res = await fetch(`${baseUrl}/api/optimize_allocation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mandate),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fakeResult);
    expect(seen).toEqual(["guard", mandate]);
  });

  it("rejects a malformed mandate with 400", async () => {
    const res = await fetch(`${baseUrl}/api/optimize_allocation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asset: "RLUSD" }),
    });
    expect(res.status).toBe(400);
  });

  it("publishes a catalog", async () => {
    const res = await fetch(`${baseUrl}/api/catalog`);
    const body = await res.json();
    expect(body.tools[0]).toMatchObject({ name: "optimize_allocation", price_drops: "500000", asset: "XRP", network: "xrpl:1" });
  });
});
