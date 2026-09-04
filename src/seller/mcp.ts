import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AllocationResult, Mandate, Opportunity } from "../shared/types.js";

export interface SellerConfig {
  payTo: string;
  network: string;
  facilitatorUrl: string;
  priceDrops: string;
  baseUrl: string;
}

export interface SellerEngine {
  listOpportunities(): Promise<Opportunity[]>;
  runAnalysis(mandate: Mandate): Promise<AllocationResult>;
}

export interface PaymentRequiredEnvelope {
  status: "payment_required";
  resource: string;
  method: "POST";
  price_drops: string;
  asset: "XRP";
  network: string;
  pay_to: string;
  description: string;
  input: Mandate;
}

export const OPTIMIZE_DESCRIPTION = "Risk-adjusted RLUSD allocation across live XRPL AMM pools";
export const OPTIMIZE_PATH = "/api/optimize_allocation";

export const MANDATE_SHAPE = {
  asset: z.literal("RLUSD").describe("Capital asset. Only RLUSD is supported."),
  amount: z.number().positive().describe("Total capital in RLUSD"),
  horizon_hours: z.number().positive().describe("Investment horizon in hours"),
  minimum_liquidity: z.number().min(0).max(1).describe("Fraction of capital that must stay liquid"),
  maximum_risk_score: z.number().min(0).max(100).describe("Reject any pool with a risk score above this"),
  maximum_protocol_allocation: z.number().min(0).max(1).describe("Maximum fraction of capital in one pool"),
};

export function buildMcpServer(cfg: SellerConfig, engine: SellerEngine): McpServer {
  const server = new McpServer({ name: "xrpl-financial-intelligence", version: "0.1.0" });

  server.registerTool(
    "list_opportunities",
    {
      description: "Free. Lists the XRP-paired AMM pools currently observed on XRPL mainnet with depth and fee only. No scores, no recommendation.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await engine.listOpportunities()) }] }),
  );

  server.registerTool(
    "optimize_allocation",
    {
      description: `Paid: ${cfg.priceDrops} drops of XRP per call via x402 on ${cfg.network}. Given a capital mandate, returns a risk-adjusted allocation across live XRPL AMM pools with expected APY, risk and liquidity scores, and reasoning. Calling this tool returns a payment_required envelope; pay the resource it names with x402 to receive the analysis.`,
      inputSchema: MANDATE_SHAPE,
    },
    async (mandate) => {
      const envelope: PaymentRequiredEnvelope = {
        status: "payment_required",
        resource: `${cfg.baseUrl}${OPTIMIZE_PATH}`,
        method: "POST",
        price_drops: cfg.priceDrops,
        asset: "XRP",
        network: cfg.network,
        pay_to: cfg.payTo,
        description: OPTIMIZE_DESCRIPTION,
        input: mandate as Mandate,
      };
      return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
    },
  );

  return server;
}
