import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MANDATE_SHAPE } from "../seller/mcp.js";
import type { Mandate } from "../shared/types.js";
import type { Orchestration } from "./orchestrate.js";
import type { SellerListing } from "./registry.js";

export interface PlatformConfig {
  payTo: string;
  network: string;
  facilitatorUrl: string;
  priceDrops: string;
  baseUrl: string;
}

export interface PlatformEngine {
  listSellers(): SellerListing[];
  orchestrate(mandate: Mandate): Promise<Orchestration>;
}

export const MATCH_DESCRIPTION = "Splits a capital mandate across seller agents by live yield and remaining capacity";
export const MATCH_PATH = "/api/find_strategy";

export interface MatchPaymentEnvelope {
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

export function buildPlatformMcpServer(cfg: PlatformConfig, engine: PlatformEngine): McpServer {
  const server = new McpServer({ name: "xrpl-fi-platform", version: "0.1.0" });

  server.registerTool(
    "list_sellers",
    {
      description: "Free. Lists seller agents with their headline APY, total capacity, risk score, exit time and price. Listed figures only — call each seller's own quote tool, or pay for find_strategy, for live capacity.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(engine.listSellers()) }] }),
  );

  server.registerTool(
    "find_strategy",
    {
      description: `Paid: ${cfg.priceDrops} drops of XRP per call via x402 on ${cfg.network}. Polls every listed seller for its current rate and remaining capacity, then splits the mandate across them by marginal yield — filling the highest-paying strategy to its capacity before moving to the next — subject to the mandate's risk ceiling, liquidity floor and concentration cap. Returns one leg per seller with the reason every rejected seller lost. Calling this tool returns a payment_required envelope; pay the resource it names with x402 to receive the split.`,
      inputSchema: MANDATE_SHAPE,
    },
    async (mandate) => {
      const envelope: MatchPaymentEnvelope = {
        status: "payment_required",
        resource: `${cfg.baseUrl}${MATCH_PATH}`,
        method: "POST",
        price_drops: cfg.priceDrops,
        asset: "XRP",
        network: cfg.network,
        pay_to: cfg.payTo,
        description: MATCH_DESCRIPTION,
        input: mandate as Mandate,
      };
      return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
    },
  );

  return server;
}

export const matchSchema = z.object(MANDATE_SHAPE);
