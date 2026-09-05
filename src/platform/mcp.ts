import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MANDATE_SHAPE } from "../shared/mandate.js";
import type { Mandate } from "../shared/types.js";
import type { MarketplacePlan } from "./marketplacePlan.js";
import type { Orchestration } from "./orchestrate.js";
import type { StrategyQuote } from "./strategy.js";
import type { PreparedPayment } from "./x402Bridge.js";

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
  /** Non-binding split for a mandate. Commits nothing and builds no plan. */
  preview(mandate: Mandate, only?: string[]): Orchestration;
  /** Live rate and remaining capacity for every listed strategy. */
  quotes(): StrategyQuote[];
  allocate(mandate: Mandate, only?: string[]): Promise<AllocationResponse>;
  /** False while market data is cold and no allocation can be produced. */
  ready(): boolean;
  /** Books a listing fee once payment has settled. */
  recordListingFee(): void;
  /** Turns a 402 challenge into a transaction a wallet can sign. */
  preparePayment(resource: string, payer: string, body?: unknown): Promise<PreparedPayment>;
  /** Claims the paid resource with a signed, unsubmitted payment. */
  completePayment(paymentId: string, signedTxBlob: string, body?: unknown): Promise<unknown>;
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
  /** Present when a payer address was supplied: sign this, then call complete_payment. */
  paymentId?: string;
  unsignedTx?: Record<string, unknown>;
  next_step?: string;
}

const PASS_PAYER =
  "Call this same tool again with your XRPL classic address in `payer` to receive a ready-to-sign payment transaction.";

/** Inputs every paid tool accepts on top of its own arguments. */
export const PAYMENT_SHAPE = {
  payer: z.string().optional().describe("Your XRPL classic address. Supply it to receive a ready-to-sign payment."),
  paymentId: z.string().optional().describe("From this tool's previous response, when returning a signature."),
  signedTxBlob: z.string().optional().describe("The signed unsignedTx (tx_blob) — signed, never submitted."),
};

export interface PaymentArgs {
  payer?: string;
  paymentId?: string;
  signedTxBlob?: string;
}

/**
 * One paid tool, called twice.
 *
 * First call returns the challenge plus the transaction that satisfies it;
 * second call returns the goods. Keeping both halves on the same tool means the
 * agent never has to learn a separate payment vocabulary — it just calls the
 * thing it wanted again, with a signature attached.
 */
async function paidCall(
  engine: PlatformEngine,
  envelope: PaymentRequiredEnvelope,
  args: PaymentArgs,
  body: unknown,
): Promise<unknown> {
  if (args.paymentId && args.signedTxBlob) {
    return await engine.completePayment(args.paymentId, args.signedTxBlob, body);
  }
  if (!args.payer) return { ...envelope, next_step: PASS_PAYER };
  const prepared = await engine.preparePayment(envelope.resource, args.payer, body);
  return {
    ...envelope,
    paymentId: prepared.paymentId,
    unsignedTx: prepared.unsignedTx,
    next_step: `Sign unsignedTx with your wallet WITHOUT submitting it, then call this same tool again with the identical arguments plus paymentId "${prepared.paymentId}" and the signed transaction blob. Submitting it yourself spends the XRP without paying for the resource.`,
  };
}

export function buildPlatformMcpServer(cfg: PlatformConfig, engine: PlatformEngine): McpServer {
  const server = new McpServer({ name: "xrpl-fi-platform", version: "0.2.0" });

  server.registerTool(
    "list_strategies",
    {
      description: `Paid: ${cfg.listPriceDrops} drops of XRP per call via x402 on ${cfg.network}. Lists every strategy with its current headline APY, total capacity, capital already committed, the rate the next unit of capital would earn, risk score, pool risk ceiling and exit time. Figures move as strategies fill, so this is a snapshot rather than a promise. Supply a \`mandate\` and the response also carries a non-binding proposed split — show it to the user and get their go-ahead before calling allocate. Pass \`strategies\` to allocate only across ones the user picked from a proposed split. Pass your XRPL address as \`payer\`; the response carries a ready-to-sign payment. Sign it without submitting and call this tool again with the same arguments plus the paymentId and signed blob.`,
      inputSchema: {
        ...PAYMENT_SHAPE,
        mandate: z
          .object(MANDATE_SHAPE)
          .optional()
          .describe("Optional. Supply a mandate to also receive a non-binding proposed split across these strategies, so you can review it before paying for an allocation."),
      },
    },
    async ({ mandate, ...args }: PaymentArgs & { mandate?: Mandate }) => {
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
      const listed = await paidCall(engine, envelope, args, mandate ? { mandate } : {});
      // A preview costs nothing extra and commits nothing: it is here so a
      // human can approve the shape of an allocation before paying for one.
      const withPreview =
        mandate && listed && typeof listed === "object" && "strategies" in listed
          ? { ...(listed as object), proposed_split: engine.preview(mandate) }
          : listed;
      return { content: [{ type: "text", text: JSON.stringify(withPreview) }] };
    },
  );

  server.registerTool(
    "allocate",
    {
      description: `Paid: ${cfg.priceDrops} drops of XRP per call via x402 on ${cfg.network}. Splits a mandate across strategies by marginal yield — filling the highest-paying strategy to its capacity before moving to the next — subject to the mandate's risk ceiling, liquidity floor and concentration cap. Returns the split, the reason every rejected strategy lost, and unsigned XRPL transactions ready for a wallet to sign. Pass \`strategies\` to allocate only across ones the user picked from a proposed split. Pass your XRPL address as \`payer\`; the response carries a ready-to-sign payment. Sign it without submitting and call this tool again with the same arguments plus the paymentId and signed blob.`,
      inputSchema: {
        ...MANDATE_SHAPE,
        ...PAYMENT_SHAPE,
        strategies: z
          .array(z.string())
          .optional()
          .describe("Optional. Strategy ids to allocate across, when the user has chosen from a proposed split. Omit to let the platform choose."),
      },
    },
    async ({ payer, paymentId, signedTxBlob, strategies, ...mandate }: Mandate & PaymentArgs & { strategies?: string[] }) => {
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
      const body = strategies ? { ...mandate, strategies } : mandate;
      return { content: [{ type: "text", text: JSON.stringify(await paidCall(engine, envelope, { payer, paymentId, signedTxBlob }, body)) }] };
    },
  );

  return server;
}
