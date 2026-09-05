import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MANDATE_SHAPE } from "../shared/mandate.js";
import type { Mandate } from "../shared/types.js";
import type { MarketplacePlan } from "./marketplacePlan.js";
import type { Orchestration } from "./orchestrate.js";
import type { StrategyQuote } from "./strategy.js";

export interface PlatformConfig {
  payTo: string;
  network: string;
  facilitatorUrl: string;
  /** Fee for a full allocation. */
  priceDrops: string;
  /** Fee for listing strategies with live capacity. */
  listPriceDrops: string;
  /** Basis points of every fee the platform keeps before paying strategy authors. */
  cutBps: number;
  baseUrl: string;
}

export interface AllocationResponse extends Orchestration, MarketplacePlan {}

export interface PlatformEngine {
  /** Live rate and remaining capacity for every listed strategy. */
  quotes(): StrategyQuote[];
  allocate(mandate: Mandate): Promise<AllocationResponse>;
  /** False while market data is cold and no allocation can be produced. */
  ready(): boolean;
  /** Books a listing fee once payment has settled. */
  recordListingFee(): void;
}

export const ALLOCATE_DESCRIPTION = "Capacity-aware allocation across listed strategies, with signable XRPL transactions";
export const ALLOCATE_PATH = "/api/allocate";
export const LIST_DESCRIPTION = "Live strategy listing with current APY and remaining capacity";
export const LIST_PATH = "/api/strategies";

export interface PaymentRequiredEnvelope {
  status: "payment_required";
  resource: string;
  method: "POST";
  price_drops: string;
  asset: "XRP";
  network: string;
  pay_to: string;
  description: string;
  input?: Mandate;
}

export function buildPlatformMcpServer(cfg: PlatformConfig, engine: PlatformEngine): McpServer {
  const server = new McpServer({ name: "xrpl-fi-platform", version: "0.2.0" });

  server.registerTool(
    "list_strategies",
    {
      description: `Paid: ${cfg.listPriceDrops} drops of XRP per call via x402 on ${cfg.network}. Lists every strategy with its current headline APY, total capacity, capital already committed, the rate the next unit of capital would earn, risk score, pool risk ceiling and exit time. Figures move as strategies fill, so this is a snapshot rather than a promise. Calling this tool returns a payment_required envelope; pay the resource it names with x402 to receive the listing.`,
      inputSchema: {},
    },
    async () => {
      const envelope: PaymentRequiredEnvelope = {
        status: "payment_required",
        resource: `${cfg.baseUrl}${LIST_PATH}`,
        method: "POST",
        price_drops: cfg.listPriceDrops,
        asset: "XRP",
        network: cfg.network,
        pay_to: cfg.payTo,
        description: LIST_DESCRIPTION,
      };
      return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
    },
  );

  server.registerTool(
    "allocate",
    {
      description: `Paid: ${cfg.priceDrops} drops of XRP per call via x402 on ${cfg.network}. Splits a mandate across strategies by marginal yield — filling the highest-paying strategy to its capacity before moving to the next — subject to the mandate's risk ceiling, liquidity floor and concentration cap. Returns the split, the reason every rejected strategy lost, and unsigned XRPL transactions ready for a wallet to sign. Calling this tool returns a payment_required envelope; pay the resource it names with x402 to receive the allocation.`,
      inputSchema: MANDATE_SHAPE,
    },
    async (mandate: Mandate) => {
      const envelope: PaymentRequiredEnvelope = {
        status: "payment_required",
        resource: `${cfg.baseUrl}${ALLOCATE_PATH}`,
        method: "POST",
        price_drops: cfg.priceDrops,
        asset: "XRP",
        network: cfg.network,
        pay_to: cfg.payTo,
        description: ALLOCATE_DESCRIPTION,
        input: mandate,
      };
      return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
    },
  );

  return server;
}
