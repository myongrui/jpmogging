import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer, type SellerConfig } from "../../src/seller/mcp.js";

const cfg: SellerConfig = {
  payTo: "rSeller",
  network: "xrpl:1",
  facilitatorUrl: "https://xrpl-facilitator-testnet.t54.ai",
  priceDrops: "500000",
  baseUrl: "http://127.0.0.1:8080",
};

const engine = {
  listOpportunities: async () => [{ ammAccount: "rA", pairLabel: "XRP/RLUSD", tvlXrp: 100, tradingFeeBps: 20 }],
  runAnalysis: async () => {
    throw new Error("must not run over MCP");
  },
};

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(cfg, engine);
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function text(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe("seller MCP server", () => {
  it("advertises both tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_opportunities", "optimize_allocation"]);
    const paid = tools.find((t) => t.name === "optimize_allocation")!;
    expect(paid.description).toContain("500000 drops");
  });

  it("serves list_opportunities for free", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "list_opportunities", arguments: {} });
    expect(text(res)).toEqual([{ ammAccount: "rA", pairLabel: "XRP/RLUSD", tvlXrp: 100, tradingFeeBps: 20 }]);
  });

  it("answers optimize_allocation with a payment_required envelope", async () => {
    const client = await connect();
    const mandate = { asset: "RLUSD", amount: 100000, horizon_hours: 72, minimum_liquidity: 0.5, maximum_risk_score: 30, maximum_protocol_allocation: 0.25 };
    const res = await client.callTool({ name: "optimize_allocation", arguments: mandate });
    expect(text(res)).toEqual({
      status: "payment_required",
      resource: "http://127.0.0.1:8080/api/optimize_allocation",
      method: "POST",
      price_drops: "500000",
      asset: "XRP",
      network: "xrpl:1",
      pay_to: "rSeller",
      description: "Risk-adjusted RLUSD allocation across live XRPL AMM pools",
      input: mandate,
    });
  });

  it("rejects an invalid mandate", async () => {
    const client = await connect();
    const res: any = await client.callTool({ name: "optimize_allocation", arguments: { asset: "RLUSD", amount: -1 } });
    expect(res.isError).toBe(true);
  });
});
