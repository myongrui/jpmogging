import type { RequestHandler } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMcp, mcpToolsToOpenAiTools } from "../../src/buyer/mcpClient.js";
import { buildSellerApp } from "../../src/seller/app.js";

const passThrough: RequestHandler = (_req, _res, next) => next();
const engine = {
  listOpportunities: async () => [{ ammAccount: "rA", pairLabel: "XRP/RLUSD", tvlXrp: 1, tradingFeeBps: 2 }],
  runAnalysis: async () => {
    throw new Error("unused");
  },
};

let server: any;
let url = "";

beforeAll(async () => {
  const app = buildSellerApp({ payTo: "rS", network: "xrpl:1", facilitatorUrl: "", priceDrops: "500000", baseUrl: "http://x" }, engine, { paymentGuard: passThrough });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  url = `http://127.0.0.1:${server.address().port}/mcp`;
});

afterAll(() => server.close());

describe("mcp bridge", () => {
  it("lists tools and converts them to OpenAI function tools", async () => {
    const bridge = await connectMcp(url);
    const tools = await bridge.listTools();
    const fnTools = mcpToolsToOpenAiTools(tools);
    expect(fnTools.map((t) => t.name).sort()).toEqual(["list_opportunities", "optimize_allocation"]);
    const paid = fnTools.find((t) => t.name === "optimize_allocation")!;
    expect(paid.type).toBe("function");
    expect(paid.strict).toBe(false);
    expect((paid.parameters as any).properties.amount.type).toBe("number");
    await bridge.close();
  });

  it("calls a tool and parses JSON text", async () => {
    const bridge = await connectMcp(url);
    expect(await bridge.callTool("list_opportunities", {})).toEqual([{ ammAccount: "rA", pairLabel: "XRP/RLUSD", tvlXrp: 1, tradingFeeBps: 2 }]);
    const env: any = await bridge.callTool("optimize_allocation", { asset: "RLUSD", amount: 1, horizon_hours: 1, minimum_liquidity: 0.5, maximum_risk_score: 30, maximum_protocol_allocation: 0.25 });
    expect(env.status).toBe("payment_required");
    expect(env.resource).toBe("http://x/api/optimize_allocation");
    await bridge.close();
  });

  it("throws on tool errors", async () => {
    const bridge = await connectMcp(url);
    await expect(bridge.callTool("optimize_allocation", { asset: "RLUSD" })).rejects.toThrow();
    await bridge.close();
  });
});
