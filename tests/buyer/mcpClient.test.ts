import type { RequestHandler } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMcp, mcpToolsToOpenAiTools } from "../../src/buyer/mcpClient.js";
import { buildPlatformApp } from "../../src/platform/app.js";

const passThrough: RequestHandler = (_req, _res, next) => next();
const engine = {
  ready: () => true,
  quotes: () => [
    { id: "alpha", name: "Alpha Deep LP", family: "amm_lp" as const, headlineApy: 0.05, capacity: 100000,
      riskScore: 22, maxPoolRisk: 25, exitHours: 1, payoutAddress: "rAuthor", requires: ["AMM"],
      deployed: 0, remaining: 100000, marginalApy: 0.05, quotedAt: "t" },
  ],
  allocate: async () => {
    throw new Error("unused");
  },
  recordListingFee: () => {},
  preparePayment: async () => {
    throw new Error("unused");
  },
  completePayment: async () => {
    throw new Error("unused");
  },
};

let server: any;
let url = "";

beforeAll(async () => {
  const app = buildPlatformApp({ payTo: "rS", network: "xrpl:1", facilitatorUrl: "", priceDrops: "500000", listPriceDrops: "10000", cutBps: 2000, baseUrl: "http://x" }, engine, { paymentGuard: passThrough, listGuard: passThrough });
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
    expect(fnTools.map((t) => t.name).sort()).toEqual(["allocate", "complete_payment", "list_strategies", "prepare_payment"]);
    const paid = fnTools.find((t) => t.name === "allocate")!;
    expect(paid.type).toBe("function");
    expect(paid.strict).toBe(false);
    expect((paid.parameters as any).properties.amount.type).toBe("number");
    await bridge.close();
  });

  it("drops $schema from tool parameters", () => {
    const [tool] = mcpToolsToOpenAiTools([{ name: "t", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {} } }]);
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });

  it("calls a tool and parses JSON text", async () => {
    const bridge = await connectMcp(url);
    const listing: any = await bridge.callTool("list_strategies", {});
    expect(listing.status).toBe("payment_required");
    expect(listing.resource).toBe("http://x/api/strategies");
    expect(listing.price_drops).toBe("10000");
    const env: any = await bridge.callTool("allocate", { asset: "RLUSD", amount: 1, horizon_hours: 1, minimum_liquidity: 0.5, maximum_risk_score: 30, maximum_protocol_allocation: 0.25 });
    expect(env.status).toBe("payment_required");
    expect(env.resource).toBe("http://x/api/allocate");
    await bridge.close();
  });

  it("throws on tool errors", async () => {
    const bridge = await connectMcp(url);
    await expect(bridge.callTool("allocate", { asset: "RLUSD" })).rejects.toThrow();
    await bridge.close();
  });
});
